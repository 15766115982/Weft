// Shared task runner: load model config, render prompt, call Azure OpenAI,
// and parse structured JSON responses. All non-streaming tasks use this.
import { loadModelsConfig } from './config.mjs';
import { resolvePrompt } from './prompts.mjs';
import { chatCompletion } from './openai.mjs';

// Simple {{variable}} substitution.
export function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

export function loadModelConfig(kbRoot) {
  const config = loadModelsConfig(kbRoot);
  if (!config) throw new Error('.kb/config/models.json not found; run llm.mjs init-prompts or create it');
  if (!config.endpoint || !config.deployment) {
    throw new Error('models.json requires endpoint and deployment');
  }
  return config;
}

export async function runPrompt(kbRoot, promptName, vars, { stream = false, temperature, max_tokens, fetchImpl, onDelta } = {}) {
  // E2E / integration stub: when WEFT_LLM_STUB is set, bypass Azure and return
  // deterministic canned output. This lets cross-service tests exercise the full
  // LLM task pipeline without network or PATs.
  if (process.env.WEFT_LLM_STUB) {
    const canned = stubFor(promptName, vars);
    if (!stream) return { prompt: '[stub]', content: canned, config: { stub: true } };
    const words = String(canned).match(/\S+\s*/g) || [''];
    let i = 0;
    const reader = {
      async read() {
        if (i >= words.length) return { done: true, value: undefined };
        const delta = words[i++];
        return { done: false, value: `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n` };
      },
      releaseLock() {},
    };
    await new Promise((r) => setTimeout(r, 5));
    let full = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const line = (value || '').toString().trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const d = parsed.choices?.[0]?.delta?.content || '';
          if (d) { full += d; if (onDelta) onDelta(d); }
        } catch {}
      }
    } finally {
      reader.releaseLock?.();
    }
    return { prompt: '[stub]', content: full, config: { stub: true } };
  }

  const config = loadModelConfig(kbRoot);
  const template = resolvePrompt(kbRoot, promptName);
  const prompt = render(template, vars);
  const defaults = config.defaults || {};
  const messages = [
    { role: 'system', content: 'You are a helpful knowledge-base assistant. Follow the output format exactly.' },
    { role: 'user', content: prompt },
  ];

  // Allow tests and callers to inject a fetch implementation without threading
  // functions through JSON input payloads.
  const effectiveFetch = fetchImpl || globalThis.__WEFT_LLM_FETCH_IMPL__;

  const res = await chatCompletion(config, messages, {
    stream,
    temperature: temperature ?? defaults.temperature ?? 0.2,
    max_tokens: max_tokens ?? defaults.max_tokens ?? 4096,
    fetchImpl: effectiveFetch,
  });

  if (!stream) {
    const content = res.choices?.[0]?.message?.content || '';
    return { prompt, content, config };
  }

  // Streaming: consume the SSE body and emit deltas.
  const reader = res.getReader();
  let full = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.isBuffer(value) ? value.toString('utf8') : (value || '');
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content || '';
          if (delta) {
            full += delta;
            if (onDelta) onDelta(delta);
          }
        } catch { /* ignore malformed SSE lines */ }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return { prompt, content: full, config };
}

export function withFetchImpl(fetchImpl, fn) {
  globalThis.__WEFT_LLM_FETCH_IMPL__ = fetchImpl;
  try {
    return fn();
  } finally {
    delete globalThis.__WEFT_LLM_FETCH_IMPL__;
  }
}

export async function withFetchImplAsync(fetchImpl, fn) {
  globalThis.__WEFT_LLM_FETCH_IMPL__ = fetchImpl;
  try {
    return await fn();
  } finally {
    delete globalThis.__WEFT_LLM_FETCH_IMPL__;
  }
}

// Best-effort JSON extraction: if the response is wrapped in markdown fences,
// strip them; otherwise parse the first JSON object/array.
export function extractJson(text) {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const payload = fence ? fence[1].trim() : trimmed;
  const firstObj = payload.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!firstObj) throw new Error('no JSON object/array found in model output');
  return JSON.parse(firstObj[1]);
}

export async function runJsonPrompt(kbRoot, promptName, vars, opts = {}) {
  const { prompt, content } = await runPrompt(kbRoot, promptName, vars, opts);
  try {
    return { prompt, data: extractJson(content), raw: content };
  } catch (err) {
    throw new Error(`failed to parse JSON from model output: ${err.message}\nraw:\n${content}`);
  }
}

// Deterministic canned output for WEFT_LLM_STUB mode. JSON prompts return valid
// JSON strings so extractJson can parse them; streaming prompts return prose.
function stubFor(promptName, vars) {
  const title = vars?.title || 'Stub Title';
  const question = vars?.question || 'the question';
  switch (promptName) {
    case 'summarize-source':
      return JSON.stringify({
        title,
        summary: `Stub summary for ${title}.`,
        key_points: ['Stub point one.', 'Stub point two.'],
      });
    case 'classify-page':
      return JSON.stringify({
        classification: 'source',
        confidence: 0.9,
        reasoning: 'Stub classification: default to source in stub mode.',
      });
    case 'extract-entity':
      return JSON.stringify({
        entities: [{ slug: 'stub-entity', title: 'Stub Entity', kind: 'component' }],
        relations: [{ from: 'stub-entity', to: 'stub-system', type: 'part-of' }],
      });
    case 'draft-concept':
      return JSON.stringify({
        slug: vars?.slug || 'stub-concept',
        title: `Stub concept ${vars?.slug || ''}`.trim(),
        body: `This is a stub concept page for ${vars?.slug || 'unknown'}.`,
      });
    case 'synthesize':
      return JSON.stringify({
        slug: vars?.slug || 'stub-synthesis',
        title: `Stub synthesis ${vars?.topic || ''}`.trim(),
        body: `This is a stub synthesis for ${vars?.topic || 'unknown'}.`,
        sources: Array.isArray(vars?.sources) ? vars.sources : [],
      });
    case 'govern-decide':
      return JSON.stringify({
        decision: 'candidate',
        reason: 'Stub mode defaults to candidate for safety.',
        referenced_decisions: [],
      });
    case 'semantic-check':
      return JSON.stringify({
        conflict: false,
        severity: 'none',
        reasoning: 'Stub mode reports no conflict.',
        contradicting_pages: [],
      });
    case 'chat':
      return `Stub answer for "${question}". In real mode this would cite approved wiki pages.`;
    case 'deep-research':
      return `Stub deep-research answer for "${question}". In real mode this would perform multi-round retrieval.`;
    default:
      return `stub answer for ${promptName}`;
  }
}
