const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const { JSDOM, VirtualConsole } = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'))('jsdom');
const { createCanvas, GlobalFonts } = require(process.env.NATIVE_CANVAS_MODULE);
const esbuild = require(project + '/node_modules/esbuild');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const distance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);

async function check() {
  const output = '/private/tmp/evalpilot-branch-drag';
  await fs.mkdir(output, { recursive: true });
  if (process.env.EVAL_CANVAS_FONT) assert.ok(GlobalFonts.registerFromPath(process.env.EVAL_CANVAS_FONT, 'system-ui'));
  const fixture = spawnSync(project + '/.venv/bin/python', ['-c', 'import json,sys;sys.path.insert(0,"backend");from ontology_domain import graph_payload,SEED;print(json.dumps(graph_payload(SEED)))'], { cwd: project, encoding: 'utf8', env: { ...process.env, PYTHONPYCACHEPREFIX: output + '/pycache' } });
  assert.equal(fixture.status, 0, fixture.stderr);
  const graph = JSON.parse(fixture.stdout);
  const original = JSON.stringify(graph);
  const bundle = await esbuild.build({ stdin: { contents: `import React,{useState} from "react";import {createRoot} from "react-dom/client";import {OntologyCanvas} from "./src/OntologyCanvas";const highlights=new Set();function App(){const [selected,setSelected]=useState("");const [paused,setPaused]=useState(window.startPaused);const [dragMode,setDragMode]=useState("branch");const [graph,setGraph]=useState(window.fixture);const [command,setCommand]=useState({type:"fit",sequence:0});window.pauseGraph=setPaused;window.mode=setDragMode;window.selectNode=setSelected;window.replaceGraph=next=>{window.fixture=next;setGraph(next)};window.command=type=>setCommand(previous=>({type,sequence:previous.sequence+1}));return <OntologyCanvas nodes={graph.nodes} edges={graph.edges} selected={selected} highlighted={highlights} highlightedEdges={highlights} paused={paused} labels spacing={1} command={command} onSelect={identifier=>{window.selections.push(identifier);setSelected(identifier)}} onDrag={event=>window.dragEvents.push(event)} network dragMode={dragMode}/>};createRoot(document.getElementById("root")).render(<App/>);`, resolveDir: project, loader: 'tsx' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
  const results = [];
  for (const options of [{ width: 1000, height: 680, paused: false }, { width: 660, height: 650, paused: true }, { width: 360, height: 480, paused: true }, { width: 1000, height: 680, paused: true, reduced: true }]) {
    const { width, height, paused, reduced = false } = options;
    const errors = [], proxy = new VirtualConsole(); proxy.on('jsdomError', error => errors.push(error.message));
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: proxy });
    const window = dom.window, document = window.document, native = createCanvas(width, height), drawing = native.getContext('2d');
    const points = [], texts = [];
    let arc = null, corners = [], frames = 0, capture = null;
    const context = new Proxy(drawing, {
      get(target, property) {
        if (property === 'clearRect') return (...values) => { frames += 1; points.length = 0; texts.length = 0; return target.clearRect(...values); };
        if (property === 'fillText') return (text, horizontal, vertical) => { texts.push({ text, x: horizontal, y: vertical, width: target.measureText(text).width }); target.fillText(text, horizontal, vertical); };
        if (property === 'beginPath') return () => { arc = null; corners = []; target.beginPath(); };
        if (property === 'arc') return (horizontal, vertical, radius, ...rest) => { assert.ok([horizontal, vertical, radius].every(Number.isFinite)); arc = { x: horizontal, y: vertical, radius }; target.arc(horizontal, vertical, radius, ...rest); };
        if (property === 'moveTo' || property === 'lineTo') return (horizontal, vertical) => { corners.push({ x: horizontal, y: vertical }); target[property](horizontal, vertical); };
        if (property === 'fill') return (...values) => { if (arc) points.push({ x: arc.x, y: arc.y }); else if (corners.length === 5) points.push({ x: corners[0].x, y: (corners[0].y + corners[2].y) / 2 }); return target.fill(...values); };
        if (property === 'stroke') return (...values) => { if (arc && target.strokeStyle === '#b5a2d4') points.push({ x: arc.x, y: arc.y }); return target.stroke(...values); };
        const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, property, value) { target[property] = value; return true; },
    });
    window.fixture = graph; window.startPaused = paused; window.dragEvents = []; window.selections = [];
    window.matchMedia = () => ({ matches: reduced });
    window.ResizeObserver = class { observe() {} disconnect() {} };
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get: () => width });
    Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => height });
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'width', { get: () => native.width, set: value => { native.width = value; } });
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'height', { get: () => native.height, set: value => { native.height = value; } });
    window.HTMLCanvasElement.prototype.getContext = () => context;
    window.HTMLCanvasElement.prototype.setPointerCapture = identifier => { capture = identifier; };
    window.HTMLCanvasElement.prototype.hasPointerCapture = identifier => capture === identifier;
    window.HTMLCanvasElement.prototype.releasePointerCapture = () => { capture = null; };
    const snapshot = () => { assert.equal(points.length, window.fixture.nodes.length, `all nodes must remain measurable at ${width}px; got ${points.length}/${window.fixture.nodes.length}`); return new Map(window.fixture.nodes.map((node, index) => [node.id, { ...points[index] }])); };
    const wait = async predicate => { const deadline = Date.now() + 2000; while (Date.now() < deadline) { assert.deepEqual(errors, []); if (predicate()) return; await delay(20); } throw new Error('Timed out: ' + predicate.toString()); };
    const save = async suffix => { drawing.globalCompositeOperation = 'destination-over'; drawing.fillStyle = '#151c23'; drawing.fillRect(0, 0, width, height); drawing.globalCompositeOperation = 'source-over'; await fs.writeFile(`${output}/branch-${width}-${reduced ? 'reduced-' : ''}${suffix}.png`, native.toBuffer('image/png')); };
    try {
      window.eval(bundle.outputFiles[0].text); await delay(paused ? 160 : 1800);
      const element = document.querySelector('canvas');
      const pointer = (type, point, extra = {}) => { const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, ...extra }); Object.defineProperty(event, 'pointerId', { value: extra.pointerId || 1 }); element.dispatchEvent(event); };
      const before = snapshot(), origin = before.get('class:cause');
      const target = { x: Math.max(100, Math.min(width - 100, origin.x + Math.min(250, width * 0.35))), y: Math.max(150, Math.min(height - 180, origin.y + 65)) };
      await save('before');
      pointer('pointermove', origin);
      assert.match(document.querySelector('.ontology-canvas-tooltip').textContent, /关联 6 个元素/);
      pointer('pointerdown', origin); pointer('pointermove', target);
      await wait(() => document.querySelector('[data-drag-phase=dragging]'));
      assert.equal(document.querySelector('[data-drag-count]').dataset.dragCount, '6');
      assert.ok(distance(snapshot().get('class:cause'), target) < 2, 'the anchor must stay under the pointer');
      const early = snapshot();
      await delay(200);
      const during = snapshot();
      const relatives = graph.nodes.filter(node => node.classId === 'cause' && node.id !== 'class:cause').map(node => node.id);
      for (const identifier of relatives) {
        assert.ok(distance(during.get(identifier), before.get(identifier)) > 20, `${identifier} must leave the dense region with its class`);
        if (!reduced) assert.ok(distance(during.get(identifier), early.get(identifier)) > 2, 'followers must move across animation frames, not teleport');
      }
      const untouched = ['class:model', 'class:action'];
      for (const identifier of untouched) assert.ok(distance(during.get(identifier), before.get(identifier)) < (paused ? 0.001 : 25), 'unrelated classes must not follow the dragged branch');
      pointer('pointerup', target); assert.equal(capture, null);
      await wait(() => document.querySelector('[data-drag-phase=settled]'));
      const landed = snapshot();
      await delay(800);
      const after = snapshot();
      assert.equal(texts.filter(item => item.text === '候选根因').length, 1, 'the dragged concept label must render only once');
      if (width >= 660) for (const identifier of relatives) assert.ok(texts.some(item => item.text === graph.nodes.find(node => node.id === identifier).label), 'all branch labels, including aliases, stay visible after release');
      for (const [index, label] of texts.entries()) for (const other of texts.slice(index + 1)) assert.ok(Math.abs(label.y - other.y) >= 12 || Math.abs(label.x - other.x) >= (label.width + other.width) / 2, `labels overlap: ${label.text} / ${other.text}`);
      assert.ok(distance(after.get('class:cause'), target) < 12, 'released root must stay in its new area, not spring back');
      for (const identifier of relatives) {
        assert.ok(distance(after.get(identifier), landed.get(identifier)) < 12, 'settling must remain local');
        assert.ok(distance(after.get(identifier), after.get('class:cause')) > 25, 'branch elements must not stick together');
      }
      assert.deepEqual(window.dragEvents.slice(0, 3).map(event => event.phase), ['dragging', 'settling', 'settled']);
      await save('after');
      window.pauseGraph(true); await delay(50);
      const stable = snapshot(), singleOrigin = stable.get('class:cause'), singleTarget = { x: singleOrigin.x - 45, y: singleOrigin.y + 30 };
      pointer('pointerdown', singleOrigin, { shiftKey: true }); pointer('pointermove', singleTarget);
      await wait(() => document.querySelector('[data-drag-phase=dragging]')?.dataset.dragCount === '1');
      await delay(100);
      const single = snapshot();
      for (const identifier of relatives) assert.ok(distance(single.get(identifier), stable.get(identifier)) < 0.001, 'Shift must leave all other elements unchanged');
      element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(() => document.querySelector('[data-drag-phase=cancelled]'));
      await delay(40); assert.equal(capture, null);
      assert.ok(distance(snapshot().get('class:cause'), stable.get('class:cause')) < 0.001, 'Escape restores the original layout');
      assert.equal(element.style.cursor, 'grab');
      for (const cancel of ['pointercancel', 'lostpointercapture', 'blur']) {
        pointer('pointerdown', singleOrigin); pointer('pointermove', singleTarget); await delay(35);
        if (cancel === 'blur') window.dispatchEvent(new window.Event('blur')); else element.dispatchEvent(new window.Event(cancel));
        await delay(45); assert.equal(capture, null);
        const restored = snapshot();
        for (const identifier of ['class:cause', ...relatives]) assert.ok(distance(restored.get(identifier), stable.get(identifier)) < 0.001, `${cancel} must restore every branch member`);
      }
      window.mode('single'); await delay(40);
      assert.match(element.getAttribute('aria-label'), /仅拖当前节点/);
      pointer('pointerdown', singleOrigin); pointer('pointermove', singleTarget); await delay(45);
      assert.equal(document.querySelector('[data-drag-count]').dataset.dragCount, '1');
      pointer('pointerup', singleTarget); await wait(() => document.querySelector('[data-drag-phase=settled]'));
      await delay(50);
      const singleSaved = snapshot();
      assert.ok(distance(singleSaved.get('class:cause'), singleTarget) < 0.001);
      const withoutAliases = { nodes: graph.nodes.filter(node => node.kind !== 'alias'), edges: graph.edges.filter(edge => edge.type !== 'alias_of') };
      window.replaceGraph(withoutAliases); await delay(100);
      assert.ok(distance(snapshot().get('class:cause'), singleTarget) < 0.001, 'filter changes must preserve the dragged layout and camera');
      window.replaceGraph(graph); await delay(80);
      const previousEvents = window.dragEvents.length;
      pointer('pointerdown', singleTarget); pointer('pointerup', singleTarget); await delay(40);
      assert.equal(window.dragEvents.length, previousEvents, 'clicking must not create a drag event');
      assert.equal(window.selections.at(-1), 'class:cause');
      pointer('pointerdown', singleTarget, { button: 2 }); pointer('pointermove', origin); pointer('pointerup', origin); await delay(40);
      assert.equal(window.dragEvents.length, previousEvents, 'right click must not start a drag');
      window.command('reset'); await delay(150);
      const reset = snapshot();
      assert.ok(distance(reset.get('class:cause'), singleTarget) > 20, 'reset must remove layout grouping');
      assert.equal(document.querySelector('[data-drag-phase]'), null);
      window.mode('branch'); await delay(40);
      const board = reset.get('mainboard'), boardTarget = { x: width / 2, y: height / 2 };
      pointer('pointerdown', board); pointer('pointermove', boardTarget); await delay(80);
      assert.ok(Number(document.querySelector('[data-drag-count]')?.dataset.dragCount) >= 5, 'an entity must bring direct business objects and its two aliases');
      window.command('fit'); await delay(70);
      assert.equal(capture, null); assert.equal(element.style.cursor, 'grab');
      assert.deepEqual(errors, []);
      assert.equal(JSON.stringify(graph), original, 'no semantic data may be mutated by layout interactions');
      results.push({ width, height, paused, reduced, nodes: graph.nodes.length, renderedFrames: frames, branchCount: 6, smoothFollowing: !reduced, cancellationModes: 4, shiftSingle: true, filtersPreserveLayout: true });
    } finally { window.close(); }
  }
  console.log(JSON.stringify({ passed: true, renderer: 'actual OntologyCanvas with native Canvas 2D and JSDOM pointer events', browserLayoutVerified: false, output, results }));
}
check().catch(error => { console.error(error); process.exitCode = 1; });
