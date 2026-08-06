// Playwright e2e pre-flight: (re)build the deterministic scratch fixture KB
// and the LLM CLI stubs that playwright.config.mjs's webServers point at.
// Idempotent; safe to re-run. Lives outside `playwright test` so the fixture
// exists before the runner spawns webServers (webServer starts before
// globalSetup, and workers re-load the config — neither can build this).
import fs from 'node:fs';
import { E2E_ROOT, E2E_KB, E2E_STUB, E2E_FAIL_STUB } from './paths.mjs';
import { buildFixtureKb, writeLlmStub } from '../test/fixtures/kb.mjs';

fs.rmSync(E2E_ROOT, { recursive: true, force: true });
buildFixtureKb({ dir: E2E_KB });
writeLlmStub(E2E_ROOT);
writeLlmStub(E2E_ROOT, { fail: true });
if (!fs.existsSync(E2E_STUB) || !fs.existsSync(E2E_FAIL_STUB)) throw new Error('stub write failed');
console.log(`e2e fixture ready: ${E2E_KB}`);
