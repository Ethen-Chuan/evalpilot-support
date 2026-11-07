import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runHarness } from '../scripts/customer_harness.mjs';

const cases = JSON.parse(await readFile(new URL('../backend/simulator_cases.json', import.meta.url), 'utf8'));
const documents = JSON.parse(await readFile(new URL('../backend/simulator_knowledge.json', import.meta.url), 'utf8'));
function requestFor(scenario = cases[0], message = scenario.question) {
  const context = { risk: !!scenario.facts.risk, handoff: !!scenario.facts.risk || !!scenario.facts.preference || /人工|真人/.test(message), inputKnown: /菜单可以|HDMI/.test(message), alreadyTried: !!scenario.facts.attempted, deviceSwitched: !!scenario.facts.previousDevice };
  const knowledge = documents.map(document => {
    let eligibleCodes = document.responses.map(response => response.code);
    if (document.id !== 'KB-BOUNDARY') {
      if (context.risk) eligibleCodes = document.id === 'KB-SAFETY' ? ['safety_stop'] : document.id === 'KB-HANDOFF' ? ['handoff'] : [];
      else if (context.handoff) eligibleCodes = document.id === 'KB-HANDOFF' ? ['handoff'] : document.id === 'KB-BLACKSCREEN' ? ['black_escalate'] : [];
      else if (document.id === 'KB-BLACKSCREEN') eligibleCodes = [context.inputKnown ? 'black_input' : 'black_clarify'];
      else if (document.id === 'KB-SAFETY') eligibleCodes = [];
    }
    return { ...document, eligibleCodes };
  });
  return { mode: 'demo', profile: 'guarded', scenario, message, history: [], model: 'fixture', knowledge, knowledgeVersion: 'test-knowledge', today: '2026-11-04', context, query: message + (context.risk ? ' 焦味 专业售后' : context.handoff ? ' 人工' : '') };
}
const base = requestFor();

test('ontology gate blocks the service function before execution and persists the denial', async () => {
  const request = requestFor(cases[1]);
  request.ontology = { protocol: 'ontology-domain-v1', revision: 1, schemaHash: 'synthetic-hash', allowedHarnessTools: ['read_case_memory', 'search_knowledge', 'read_policy', 'create_handoff_draft'], alignment: { status: 'clarify' } };
  const result = await runHarness(request);
  assert.ok(result.events.some(event => event.name === '本体执行前校验' && event.status === 'blocked' && event.input.tool === 'lookup_service'));
  assert.ok(result.events.some(event => event.name === 'lookup_service' && event.status === 'blocked'));
  assert.equal(result.events.filter(event => event.name === 'lookup_service' && event.status === 'succeeded').length, 0);
});

function streamResponse(blocks, reason = 'end_turn') {
  const events = [{ type: 'message_start', message: { id: 'msg-fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 50, output_tokens: 0 } } }];
  for (const [index, block] of blocks.entries()) {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { ...block, text: '' } : block });
    if (block.type === 'text') events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    events.push({ type: 'content_block_stop', index });
  }
  events.push({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 25 } }, { type: 'message_stop' });
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('real DSH executes bounded tools for all five offline scenarios', async () => {
  for (const scenario of cases) {
    const result = await runHarness(requestFor(scenario));
    assert.equal(result.harness.name, 'DeepSeek Harness');
    assert.ok(result.steps >= 3 && result.steps <= 4);
    assert.equal(result.finishReason, 'stop');
    assert.ok(result.events.some(event => event.name === 'read_policy'));
    assert.ok(result.events.some(event => event.name === 'read_case_memory'));
    assert.ok(result.events.some(event => event.name === 'search_knowledge' && event.status === 'succeeded'));
    assert.ok(result.output.responseCodes.includes('boundary'));
    assert.equal(result.output.answer, undefined);
    assert.equal(result.usage, null);
    assert.ok(!JSON.stringify(result).includes('reasoning_content'));
  }
});

test('baseline is explicitly offline and manual escalation preserves history', async () => {
  const baseline = await runHarness({ ...base, profile: 'baseline' });
  assert.equal(baseline.steps, 1);
  assert.equal(baseline.events.filter(event => event.type === 'tool').length, 0);
  const history = [{ role: 'user', content: '菜单可以打开，换线仍无效。' }];
  const guarded = await runHarness({ ...requestFor(cases[0], '我要人工'), history });
  assert.equal(guarded.output.action, 'handoff');
  assert.deepEqual(guarded.events.find(event => event.name === 'create_handoff_draft' && event.status === 'succeeded').output.history, history);
});

test('rejects absent credentials, live baseline and oversized inputs before dispatch', async () => {
  for (const input of [{ ...base, mode: 'live' }, { ...base, mode: 'live', profile: 'baseline', credential: 'fixture-only-not-secret' }, { ...base, message: 'x'.repeat(1201) }]) await assert.rejects(runHarness(input));
});

test('official live adapter makes bounded Messages requests, invokes tools and never sends labels', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const credential = 'fixture-only-not-secret';
  globalThis.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    assert.equal(String(url), 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).get('x-api-key'), credential);
    const payload = requests.at(-1);
    assert.equal(payload.max_tokens, 1200);
    assert.deepEqual(payload.tools.map(tool => tool.name).sort(), ['create_handoff_draft', 'lookup_service', 'read_case_memory', 'read_policy', 'search_knowledge']);
    if (requests.length === 1) return streamResponse([{ type: 'tool_use', id: 'memory', name: 'read_case_memory', input: {} }, { type: 'tool_use', id: 'search', name: 'search_knowledge', input: { query: '黑屏' } }], 'tool_use');
    if (requests.length === 2) return streamResponse([{ type: 'tool_use', id: 'policy', name: 'read_policy', input: { ids: ['KB-BOUNDARY', 'KB-BLACKSCREEN'] } }], 'tool_use');
    return streamResponse([{ type: 'text', text: JSON.stringify({ action: 'clarify', intent: 'fault_repair', responseCodes: ['black_clarify', 'boundary'], evidenceIds: ['KB-BLACKSCREEN@1.0', 'KB-BOUNDARY@1.0'] }) }]);
  };
  try {
    const result = await runHarness({ ...base, mode: 'live', credential, scenario: { id: base.scenario.id, facts: base.scenario.facts } });
    assert.equal(requests.length, 3);
    assert.equal(result.steps, 3);
    assert.equal(result.output.action, 'clarify');
    assert.ok(!JSON.stringify(result).includes(credential));
    assert.equal(process.env.EVALPILOT_DSH_KEY, undefined);
    assert.ok(result.events.some(event => event.name === 'read_policy'));
    assert.ok(!JSON.stringify(requests).includes('"reference"'));
  } finally { globalThis.fetch = originalFetch; }
});

test('official adapter does not retry provider failures and clears credentials', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return new Response('upstream fixture error', { status: 503 }); };
  try {
    await assert.rejects(runHarness({ ...base, mode: 'live', credential: 'fixture-only-not-secret' }));
    assert.equal(requests, 1);
    assert.equal(process.env.EVALPILOT_DSH_KEY, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('looping tool requests are stopped at the step budget', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return streamResponse([{ type: 'tool_use', id: `memory-${requests}`, name: 'read_case_memory', input: {} }], 'tool_use'); };
  try {
    const received = [];
    await assert.rejects(runHarness({ ...base, mode: 'live', credential: 'fixture-only-not-secret' }, event => received.push(event)));
    assert.equal(requests, 5);
    assert.ok(received.some(event => event.name === 'read_case_memory' && event.status === 'succeeded'));
    assert.deepEqual(received.map(event => event.sequence), Array.from({ length: received.length }, (_value, index) => index + 1));
  } finally { globalThis.fetch = originalFetch; }
});

test('policy lookup cannot bypass memory and search stages; denial is observable', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) return streamResponse([{ type: 'tool_use', id: 'skip', name: 'read_policy', input: { ids: ['KB-BOUNDARY', 'KB-REFUND'] } }], 'tool_use');
    return streamResponse([{ type: 'text', text: JSON.stringify({ action: 'explain', intent: 'policy_inquiry', responseCodes: [], evidenceIds: [] }) }]);
  };
  try {
    const result = await runHarness({ ...base, mode: 'live', credential: 'fixture-only-not-secret' });
    assert.ok(result.events.some(event => event.name === 'read_policy' && event.status === 'blocked'));
    assert.ok(!result.events.some(event => event.name === 'read_policy' && event.status === 'succeeded'));
  } finally { globalThis.fetch = originalFetch; }
});

test('expired and draft knowledge cannot be retrieved', async () => {
  for (const change of [{ expiresAt: '2026-01-01' }, { status: 'draft' }]) {
    const knowledge = base.knowledge.map(document => document.id === 'KB-BLACKSCREEN' ? { ...document, ...change } : document);
    const result = await runHarness({ ...base, knowledge });
    assert.deepEqual(result.output.responseCodes, []);
    assert.equal(result.events.find(event => event.name === 'search_knowledge' && event.status === 'succeeded').output.status, 'insufficient');
  }
});

test('unknown tools are never executed and bulk calls trip the tool budget', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) return streamResponse([{ type: 'tool_use', id: 'untrusted', name: 'shell', input: { command: 'no-execution' } }], 'tool_use');
    return streamResponse([{ type: 'text', text: JSON.stringify({ answer: '工具不可用。', action: 'explain', intent: 'other' }) }]);
  };
  try {
    const result = await runHarness({ ...base, mode: 'live', credential: 'fixture-only-not-secret' });
    assert.ok(!result.events.some(event => event.name === 'shell'));
    globalThis.fetch = async () => streamResponse(Array.from({ length: 7 }, (_, index) => ({ type: 'tool_use', id: `bulk-${index}`, name: 'read_policy', input: {} })), 'tool_use');
    await assert.rejects(runHarness({ ...base, mode: 'live', credential: 'fixture-only-not-secret' }));
  } finally { globalThis.fetch = originalFetch; }
});
