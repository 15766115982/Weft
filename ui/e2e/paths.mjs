// Shared paths/constants for the Playwright e2e layer.
import path from 'node:path';
import os from 'node:os';

export const E2E_ROOT = path.join(os.tmpdir(), 'weft-e2e-fixture');
export const E2E_KB = path.join(E2E_ROOT, 'kb');
export const E2E_STUB = path.join(E2E_ROOT, 'llm-stub.mjs');
export const E2E_FAIL_STUB = path.join(E2E_ROOT, 'llm-stub-fail.mjs');

// Ports avoid 8322+ (the operator's real portal may be running there).
export const MAIN = 'http://127.0.0.1:8422'; // good LLM stub
export const FAILING_LLM = 'http://127.0.0.1:8424'; // failing LLM stub
