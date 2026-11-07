const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const esbuild = require(project + '/node_modules/esbuild');
const dependency = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'));
const { JSDOM } = dependency('jsdom');
const sharp = createRequire(path.resolve(process.env.PLAYWRIGHT_PACKAGE_ROOT, 'package.json'))('sharp');

async function preview() {
  const base = process.env.EVAL_ONTOLOGY_BASE || 'http://127.0.0.1:4294';
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const graph = await (await fetch(base + '/api/support/ontology/graph?mode=example')).json();
  assert.equal(graph.mode, 'example');
  const built = await esbuild.build({ stdin: { contents: 'import React from "react"; import {renderToStaticMarkup} from "react-dom/server"; import {OntologyObjectGraph} from "./src/OntologyObjectGraph"; export {exampleExploration,visibleGraph} from "./src/ontologyGraph"; export {objectLayout,objectCamera} from "./src/ontologyObjectLayout"; export const render = props => renderToStaticMarkup(<OntologyObjectGraph {...props}/>);', resolveDir: project, loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', define: { 'process.env.NODE_ENV': '"production"' } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
  const { exampleExploration, visibleGraph, objectLayout, objectCamera, render } = module.exports;
  const output = '/private/tmp/evalpilot-object-design';
  await fs.mkdir(output, { recursive: true });
  const css = (await fs.readFile(project + '/src/ontology-studio.css', 'utf8')).replaceAll('var(--mono)', 'monospace').replaceAll('var(--object-color)', '#9ebce1');
  const results = [];
  for (const topic of ['aliases', 'models', 'safety']) {
    const shown = visibleGraph(graph, 'explore', '', 1, new Set(), new Set(), '', null, exampleExploration(graph, topic));
    const layout = objectLayout(shown.nodes, shown.edges);
    for (const card of layout.cards) for (const other of layout.cards.filter(other => other.id !== card.id)) {
      assert.ok(card.x + card.width <= other.x || other.x + other.width <= card.x || card.y + card.height <= other.y || other.y + other.height <= card.y);
    }
    const selected = shown.nodes.find(node => node.label === '主机')?.id || shown.nodes[0].id;
    const markup = render({ ...shown, selected, highlighted: new Set(), highlightedEdges: new Set(), command: { type: 'fit', sequence: 0 }, onSelect() {}, labels: true, exploring: true, expandable: new Set(shown.nodes.map(node => node.id)) });
    const document = new JSDOM(markup).window.document;
    const svg = document.querySelector('.ontology-object-svg');
    const width = 1100, height = 510;
    const camera = objectCamera(layout, width, height);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height)); svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.querySelector(':scope>g').setAttribute('transform', `translate(${camera.x} ${camera.y}) scale(${camera.scale})`);
    const source = svg.outerHTML.replace(/(<svg[^>]+>)/, '$1<style>' + css + '</style><rect width="1100" height="510" fill="#111922"/>');
    await fs.writeFile(path.join(output, topic + '.svg'), source);
    await sharp(Buffer.from(source)).png().toFile(path.join(output, topic + '.png'));
    await sharp(Buffer.from(source)).resize(550).png().toFile(path.join(output, topic + '-thumb.png'));
    results.push({ topic, nodes: shown.nodes.length, edges: shown.edges.length, width, height, minimumNameSize: camera.scale * 16, overlappingCards: 0 });
  }
  await fs.writeFile(path.join(output, 'preview-report.json'), JSON.stringify({ results, method: 'actual React SVG rendered through librsvg; not a browser or full-app screenshot', browserVerification: false }, null, 2));
  console.log(JSON.stringify({ output, results }));
}
preview().catch(error => { console.error(error); process.exitCode = 1; });
