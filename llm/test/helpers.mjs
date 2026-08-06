// Test helpers for the LLM service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(prefix = 'kb-llm-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeKb(root) {
  fs.mkdirSync(path.join(root, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(root, 'wiki', 'sources'), { recursive: true });
  fs.mkdirSync(path.join(root, 'wiki', 'entities'), { recursive: true });
  fs.mkdirSync(path.join(root, 'wiki', 'concepts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'wiki', 'syntheses'), { recursive: true });
  fs.mkdirSync(path.join(root, '.kb'), { recursive: true });
  fs.writeFileSync(path.join(root, 'kb.json'), JSON.stringify({ version: 2 }));
  return root;
}

export function writeModelsConfig(root, config) {
  const dir = path.join(root, '.kb', 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(config, null, 2));
}

export function slurpLines(p) {
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

// Returns a fetch impl that responds with a non-streaming JSON completion.
export function mockFetchJson(content) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

// Returns a fetch impl that responds with a streaming SSE completion.
export function mockFetchStream(chunks) {
  return async () => {
    let index = 0;
    return {
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        getReader() {
          return {
            async read() {
              if (index >= chunks.length) return { done: true, value: undefined };
              const value = chunks[index++];
              return { done: false, value };
            },
            releaseLock() {},
          };
        },
      },
    };
  };
}

// Build SSE data lines for mockFetchStream.
export function sseChunks(text) {
  const lines = [];
  for (const ch of text) {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
  }
  return lines;
}
