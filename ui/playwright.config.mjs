// Playwright config for the UI portal regression suite.
// Run via `npm run test:e2e` — e2e/prepare.mjs rebuilds the scratch
// fixture KB first (webServers reference it by fixed path).
// Two portals over the same scratch KB:
//   8422 good LLM stub    (main cases)
//   8424 failing stub     (stream failure)
import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import { E2E_ROOT, E2E_KB, E2E_STUB, E2E_FAIL_STUB } from './e2e/paths.mjs';

// Safety net for `npx playwright test` without the prepare step: build the
// fixture only if missing (the npm script always rebuilds it fresh).
if (!fs.existsSync(E2E_KB)) {
  const { buildFixtureKb, writeLlmStub } = await import('./test/fixtures/kb.mjs');
  fs.rmSync(E2E_ROOT, { recursive: true, force: true });
  buildFixtureKb({ dir: E2E_KB });
  writeLlmStub(E2E_ROOT);
  writeLlmStub(E2E_ROOT, { fail: true });
}

const serve = (port, env) => ({
  command: `node serve.mjs --kb "${E2E_KB}" --port ${port}`,
  cwd: import.meta.dirname,
  port,
  reuseExistingServer: false,
  stdout: 'ignore',
  stderr: 'pipe',
  env: { ...process.env, ...env },
});

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1, // two portals share one scratch KB — keep runs serial
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8422',
    locale: 'zh-CN',
  },
  webServer: [
    serve(8422, { WEFT_LLM_CLI: E2E_STUB }),
    serve(8424, { WEFT_LLM_CLI: E2E_FAIL_STUB }),
  ],
  globalTeardown: './e2e/teardown.mjs',
});
