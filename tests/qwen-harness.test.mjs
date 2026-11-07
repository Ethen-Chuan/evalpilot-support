import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runHarness } from '../scripts/customer_harness.mjs';
import { QwenAdapter, qwenEndpoint } from '../scripts/qwen_harness_adapter.mjs';

const cases = JSON.parse(await readFile(new URL('../backend/simulator_cases.json', import.meta.url), 'utf8'));
const documents = JSON.parse(await readFile(new URL('../backend/simulator_knowledge.json', import.meta.url), 'utf8'));
const regions = JSON.parse(await readFile(new URL('../backend/qwen_regions.json', import.meta.url), 'utf8'));
const credential = 'fixture-only-not-secret';
const answer = { action: 'clarify', intent: 'fault_repair', responseCodes: ['black_clarify', 'boundary'], evidenceIds: ['KB-BLACKSCREEN@1.0', 'KB-BOUNDARY@1.0'] };
const base = {
  mode: 'live', profile: 'guarded', provider: 'qwen', endpoint: regions[1].endpoint, model: 'qwen-fixture', credential,
  scenario: { id: cases[0].id, facts: cases[0].facts }, message: cases[0].question, history: [], today: '2026-11-04',
  knowledgeVersion: 'test-knowledge', query: '黑屏', context: { risk: false, handoff: false, alreadyTried: true, inputKnown: false },
  knowledge: documents.map(document => ({ ...document, eligibleCodes: document.id === 'KB-BOUNDARY' ? ['boundary'] : document.id === 'KB-BLACKSCREEN' ? ['black_clarify'] : [] })),
};

function responseFor(calls, content = null, finish = calls.length ? 'tool_calls' : 'stop') {
  return Response.json({ choices: [{ finish_reason: finish, message: { content, tool_calls: calls.map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }], usage: { prompt_tokens: 50, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 20 } } });
}

test('Qwen runs the actual DSH loop with ordered tool evidence and correct regional HTTP payload', async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, regions[1].endpoint + '/chat/completions');
    assert.equal(options.redirect, 'error');
    const headers = new Headers(options.headers);
    assert.equal(headers.get('Authorization'), 'Bearer ' + credential);
    assert.ok(headers.get('user-agent'));
    const payload = JSON.parse(options.body);
    requests.push(payload);
    assert.equal(payload.model, base.model);
    assert.equal(payload.enable_thinking, false);
    assert.equal(payload.stream, false);
    assert.equal(payload.max_tokens, 1200);
    assert.equal(payload.parallel_tool_calls, false);
    assert.equal(payload.tools.length, 5);
    assert.ok(payload.tools.every(tool => tool.type === 'function' && tool.function.parameters.type === 'object'));
    if (requests.length === 1) return responseFor([['memory', 'read_case_memory', {}], ['search', 'search_knowledge', { query: '黑屏' }]]);
    if (requests.length === 2) {
      assert.ok(payload.messages.some(message => message.role === 'tool' && message.tool_call_id === 'memory'));
      assert.ok(payload.messages.some(message => message.role === 'assistant' && message.tool_calls?.length === 2));
      return responseFor([['policy', 'read_policy', { ids: ['KB-BOUNDARY', 'KB-BLACKSCREEN'] }]]);
    }
    return responseFor([], JSON.stringify(answer));
  };
  try {
    const result = await runHarness(base);
    assert.equal(result.harness.name, 'DeepSeek Harness');
    assert.equal(result.harness.provider, 'qwen-official');
    assert.equal(result.steps, 3);
    assert.deepEqual(result.output, answer);
    assert.deepEqual(result.usage, { inputTokens: 90, outputTokens: 75, cacheReadTokens: 60, totalTokens: 225 });
    assert.deepEqual(result.events.filter(event => event.type === 'tool' && event.status === 'succeeded').map(event => event.name), ['read_case_memory', 'search_knowledge', 'read_policy']);
    assert.ok(!JSON.stringify(result).includes(credential));
    assert.ok(!JSON.stringify(requests).includes('referenceAnswer'));
    assert.equal(process.env.EVALPILOT_DSH_KEY, undefined);
  } finally { globalThis.fetch = original; }
});

test('Qwen allows only official shared or workspace endpoints before any dispatch', async () => {
  for (const region of regions) {
    if (region.endpoint) assert.equal(qwenEndpoint(region.endpoint), region.endpoint);
    const address = `https://workspace-test.${region.id}.maas.aliyuncs.com/compatible-mode/v1`;
    assert.equal(qwenEndpoint(address), address);
  }
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('must not dispatch'); };
  try {
    for (const endpoint of [undefined, 'https://untrusted.invalid/v1', 'http://dashscope.aliyuncs.com/compatible-mode/v1', regions[0].endpoint + '?token=x', regions[0].endpoint + '/chat/completions', 'https://workspace.bad-region.maas.aliyuncs.com/compatible-mode/v1']) {
      await assert.rejects(runHarness({ ...base, endpoint }));
    }
    await assert.rejects(runHarness({ ...base, provider: 'unregistered' }));
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});

test('Qwen upstream failures preserve safe codes without retries or response leakage', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [400, 401, 403, 404, 429, 503]) {
      let requests = 0;
      globalThis.fetch = async () => { requests += 1; return Response.json({ error: credential }, { status }); };
      await assert.rejects(runHarness(base), error => {
        assert.ok(!error.message.includes(credential));
        return error.message === (status === 503 ? 'QWEN_HTTP_ERROR' : `QWEN_HTTP_${status}`);
      });
      assert.equal(requests, 1);
    }
  } finally { globalThis.fetch = original; }
});

test('Qwen malformed, truncated, private and oversized outputs fail closed', async () => {
  const original = globalThis.fetch;
  const malformed = Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'bad', type: 'function', function: { name: 'read_case_memory', arguments: '{not-json' } }] } }] });
  const responses = [responseFor([], JSON.stringify(answer), 'length'), responseFor([], credential), malformed, new Response('x'.repeat(262145)), responseFor([], null), responseFor(Array.from({ length: 7 }, (_, index) => [`call-${index}`, 'read_case_memory', {}]))];
  try {
    for (const response of responses) {
      globalThis.fetch = async () => response;
      await assert.rejects(runHarness(base));
    }
  } finally { globalThis.fetch = original; }
});

test('Qwen step and tool boundaries remain enforced by the shared DSH loop', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => responseFor([[`repeat-${++requests}`, 'read_case_memory', {}]]);
  try {
    await assert.rejects(runHarness(base));
    assert.equal(requests, 5);
    requests = 0;
    globalThis.fetch = async () => ++requests === 1 ? responseFor([['skip-policy', 'read_policy', { ids: ['KB-BOUNDARY', 'KB-BLACKSCREEN'] }]]) : responseFor([], JSON.stringify(answer));
    const result = await runHarness(base);
    assert.ok(result.events.some(event => event.name === 'read_policy' && event.status === 'blocked'));
    assert.ok(!result.events.some(event => event.name === 'read_policy' && event.status === 'succeeded'));
  } finally { globalThis.fetch = original; }
});

test('Qwen adapter clears credentials and rejects unsupported attachments', async () => {
  const adapter = new QwenAdapter(base);
  const options = { model: base.model, messages: [{ role: 'user', content: [{ type: 'image' }] }] };
  await assert.rejects(async () => { for await (const chunk of adapter.stream(options)) assert.fail(chunk.type); });
  adapter.clear();
  assert.equal(adapter.credential, '');
  await assert.rejects(async () => { for await (const chunk of adapter.stream({ ...options, messages: [] })) assert.fail(chunk.type); }, /QWEN_AUTH/);
});
