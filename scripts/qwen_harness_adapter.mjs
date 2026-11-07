import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { readFileSync } from 'node:fs';

const regions = JSON.parse(readFileSync(new URL('../backend/qwen_regions.json', import.meta.url), 'utf8'));
const workspaceAddress = new RegExp(`^https://[a-z0-9][a-z0-9-]{0,62}\\.(${regions.map(region => region.id).join('|')})\\.maas\\.aliyuncs\\.com/compatible-mode/v1$`);

export function qwenEndpoint(value) {
  if (typeof value !== 'string') throw new Error('QWEN_ENDPOINT');
  const endpoint = value.replace(/\/$/, '');
  if (!regions.some(region => region.endpoint === endpoint) && !workspaceAddress.test(endpoint)) throw new Error('QWEN_ENDPOINT');
  return endpoint;
}

function messagesFor(options) {
  const messages = options.system ? [{ role: 'system', content: options.system }] : [];
  for (const message of options.messages) {
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) || !Array.isArray(message.content)) throw new Error('QWEN_PROTOCOL');
    if (message.content.some(block => !['text', 'tool-call', 'tool-addition', 'tool-removal'].includes(block.type))) throw new Error('QWEN_PROTOCOL');
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (message.role === 'tool') {
      if (!message.toolCallId) throw new Error('QWEN_PROTOCOL');
      messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: text });
    } else if (message.role === 'assistant') {
      const calls = message.content.filter(block => block.type === 'tool-call').map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }));
      if (text || calls.length) messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (text) messages.push({ role: message.role === 'developer' ? 'system' : message.role, content: text });
  }
  return messages;
}

async function readBounded(response) {
  if (!response.body) throw new Error('QWEN_PROTOCOL');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 262144) throw new Error('QWEN_RESPONSE_LIMIT');
      chunks.push(Buffer.from(chunk.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class QwenAdapter extends LlmAdapter {
  constructor({ endpoint, credential }) {
    super();
    this.endpoint = qwenEndpoint(endpoint);
    this.credential = credential;
    this.failureCode = null;
    this.callIds = new Set();
  }

  providerRetryPolicy() { return { mode: 'normal', maxRetries: 0, retryableCodes: [] }; }

  clear() { this.credential = ''; }

  async *stream(options) {
    try {
      if (!this.credential) throw new Error('QWEN_AUTH');
      const timeout = AbortSignal.timeout(45000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const payload = { model: options.model, messages: messagesFor(options), stream: false, enable_thinking: false, max_tokens: Math.min(options.maxTokens || 1200, 1200) };
      if (options.tools?.length) {
        payload.tools = options.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
        payload.tool_choice = 'auto';
        payload.parallel_tool_calls = false;
      }
      const response = await fetch(this.endpoint + '/chat/completions', { method: 'POST', headers: { ...attributionHeaders(), 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.credential }, body: JSON.stringify(payload), redirect: 'error', signal });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new Error([400, 401, 403, 404, 429].includes(response.status) ? `QWEN_HTTP_${response.status}` : 'QWEN_HTTP_ERROR');
      }
      const decoded = await readBounded(response);
      if (JSON.stringify(decoded).includes(this.credential)) throw new Error('QWEN_PRIVATE_RESPONSE');
      const choice = decoded?.choices?.[0];
      const message = choice?.message;
      if (!message || !['stop', 'tool_calls'].includes(choice.finish_reason) || message.refusal) throw new Error('QWEN_INCOMPLETE');
      const calls = message.tool_calls ?? [];
      if (!Array.isArray(calls) || calls.length > 6 || (choice.finish_reason === 'tool_calls') !== !!calls.length) throw new Error('QWEN_PROTOCOL');
      if (message.content != null && typeof message.content !== 'string') throw new Error('QWEN_PROTOCOL');
      const blocks = message.content ? [{ type: 'text', text: message.content }] : [];
      for (const call of calls) {
        if (call.type !== 'function' || typeof call.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(call.id) || this.callIds.has(call.id) || typeof call.function?.name !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(call.function.name) || typeof call.function.arguments !== 'string' || call.function.arguments.length > 8192) throw new Error('QWEN_PROTOCOL');
        const args = JSON.parse(call.function.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('QWEN_PROTOCOL');
        this.callIds.add(call.id);
        blocks.push({ type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
      if (!blocks.length) throw new Error('QWEN_INCOMPLETE');
      for (const [index, block] of blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type };
        if (block.type === 'text') yield { type: 'text-delta', index, text: block.text };
        else yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index, block };
      }
      const reported = decoded.usage;
      if (reported && Number.isSafeInteger(reported.prompt_tokens) && reported.prompt_tokens >= 0 && Number.isSafeInteger(reported.completion_tokens) && reported.completion_tokens >= 0) {
        const cached = reported.prompt_tokens_details?.cached_tokens;
        const cacheReadTokens = Number.isSafeInteger(cached) && cached >= 0 && cached <= reported.prompt_tokens ? cached : 0;
        const usage = { inputTokens: reported.prompt_tokens - cacheReadTokens, outputTokens: reported.completion_tokens, cacheReadTokens, totalTokens: reported.prompt_tokens + reported.completion_tokens };
        yield { type: 'usage', usage };
      }
      yield { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } };
    } catch (error) {
      this.failureCode = /^QWEN_(AUTH|PROTOCOL|INCOMPLETE|RESPONSE_LIMIT|PRIVATE_RESPONSE|HTTP_(400|401|403|404|429|ERROR))$/.test(error.message) ? error.message : 'QWEN_NETWORK';
      throw new Error(this.failureCode);
    }
  }
}
