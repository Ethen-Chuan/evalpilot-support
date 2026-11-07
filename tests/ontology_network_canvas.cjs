const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const { JSDOM } = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'))('jsdom');
const { createCanvas, GlobalFonts } = require(process.env.NATIVE_CANVAS_MODULE);
const esbuild = require(project + '/node_modules/esbuild');

async function check() {
  const output = process.env.EVAL_CANVAS_OUTPUT || '/private/tmp/evalpilot-network-canvas';
  assert.ok(output.startsWith('/private/tmp/'));
  await fs.mkdir(output, { recursive: true });
  if (process.env.EVAL_CANVAS_FONT) assert.ok(GlobalFonts.registerFromPath(process.env.EVAL_CANVAS_FONT, 'system-ui'));
  const fixture = spawnSync(project + '/.venv/bin/python', ['-c', 'import json,sys;sys.path.insert(0,"backend");from ontology_domain import graph_payload,SEED;print(json.dumps(graph_payload(SEED)))'], { cwd: project, encoding: 'utf8', env: { ...process.env, PYTHONPYCACHEPREFIX: output + '/pycache' } });
  assert.equal(fixture.status, 0, fixture.stderr);
  const graph = JSON.parse(fixture.stdout);
  const bundle = await esbuild.build({ stdin: { contents: 'import React,{useState} from "react";import {createRoot} from "react-dom/client";import {OntologyCanvas} from "./src/OntologyCanvas";const highlights=new Set();const command={type:"fit",sequence:0};function App(){const [selected,setSelected]=useState("");const [paused,setPaused]=useState(false);window.selectNode=setSelected;window.pauseGraph=setPaused;return <OntologyCanvas nodes={window.fixture.nodes} edges={window.fixture.edges} selected={selected} highlighted={highlights} highlightedEdges={highlights} paused={paused} labels spacing={1} command={command} onSelect={setSelected} network/>};createRoot(document.getElementById("root")).render(<App/>);', resolveDir: project, loader: 'tsx' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
  const results = [];
  for (const [width, height] of [[1000, 680], [660, 650], [360, 480]]) {
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { runScripts: 'dangerously', pretendToBeVisual: true });
    const window = dom.window, native = createCanvas(width, height), drawing = native.getContext('2d');
    const labels = [], arcs = [];
    let painted = 0;
    const context = new Proxy(drawing, {
      get(target, property) {
        if (property === 'clearRect') return (...values) => { painted += 1; labels.length = 0; arcs.length = 0; return target.clearRect(...values); };
        if (property === 'fillText') return (text, horizontal, vertical) => { assert.ok([horizontal, vertical].every(Number.isFinite)); labels.push({ text, horizontal, vertical }); return target.fillText(text, horizontal, vertical); };
        if (property === 'arc') return (...values) => { assert.ok(values.every(Number.isFinite)); arcs.push(values.slice(0, 3)); return target.arc(...values); };
        const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, property, value) { target[property] = value; return true; },
    });
    window.fixture = graph;
    window.matchMedia = () => ({ matches: false });
    window.ResizeObserver = class { observe() {} disconnect() {} };
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get: () => width });
    Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => height });
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'width', { get: () => native.width, set: value => { native.width = value; } });
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'height', { get: () => native.height, set: value => { native.height = value; } });
    window.HTMLCanvasElement.prototype.getContext = () => context;
    const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const save = async suffix => {
      drawing.globalCompositeOperation = 'destination-over'; drawing.fillStyle = '#151c23'; drawing.fillRect(0, 0, width, height); drawing.globalCompositeOperation = 'source-over';
      await fs.writeFile(path.join(output, `network-${width}-${suffix}.png`), native.toBuffer('image/png'));
    };
    try {
      window.eval(bundle.outputFiles[0].text);
      await delay(2600);
      assert.ok(painted > 0 && labels.length > 0 && arcs.length >= graph.nodes.filter(node => node.kind !== 'rule').length);
      assert.ok(arcs.every(([horizontal, vertical, radius]) => horizontal - radius >= 0 && vertical - radius >= 0 && horizontal + radius <= width && vertical + radius <= height));
      assert.ok(labels.every(label => label.horizontal > 0 && label.horizontal < width && label.vertical > 0 && label.vertical < height));
      await save('overview');
      window.pauseGraph(true); await delay(60);
      const before = arcs.map(point => JSON.stringify(point)), frames = painted;
      await delay(120); assert.equal(painted, frames, 'paused graph must not repaint continuously');
      window.selectNode('mainboard'); await delay(80);
      assert.ok(labels.some(label => label.text === '主板'));
      if (width >= 660) for (const alias of ['主控板', '控制板']) assert.ok(labels.some(label => label.text === alias), `selected canonical entity must show alias at ${width}px: ${alias}`);
      const after = new Set(arcs.map(point => JSON.stringify(point)));
      assert.ok(before.every(point => after.has(point)), 'selection must not reheat or move paused nodes');
      await save('mainboard');
      results.push({ width, height, nodes: graph.nodes.length, edges: graph.edges.length, visibleLabels: labels.length, selectionPainted: painted > frames, pausedPositionsPreserved: before.every(point => after.has(point)) });
    } finally { window.close(); }
  }
  console.log(JSON.stringify({ passed: true, output, renderer: 'actual OntologyCanvas in JSDOM with native Canvas 2D', browserLayoutVerified: false, results }));
}
check().catch(error => { console.error(error); process.exitCode = 1; });
