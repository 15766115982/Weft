// Shared paths/constants for the Playwright e2e layer.
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const E2E_ROOT = path.join(os.tmpdir(), 'weft-e2e-fixture');
export const E2E_KB = path.join(E2E_ROOT, 'kb');
export const E2E_STUB = path.join(E2E_ROOT, 'llm-stub.mjs');
export const E2E_FAIL_STUB = path.join(E2E_ROOT, 'llm-stub-fail.mjs');

export const E2E_PASSWORD = 'e2e-password-123';
export const E2E_PASSWORD_HASH =
  crypto.createHash('sha256').update(E2E_PASSWORD, 'utf8').digest('hex');

// Ports avoid 8322+ (the operator's real portal may be running there).
export const CONFIGURED = 'http://127.0.0.1:8422'; // admin configured, good LLM stub
export const UNCONFIGURED = 'http://127.0.0.1:8423'; // no WEFT_ADMIN_PASSWORD_HASH
export const FAILING_LLM = 'http://127.0.0.1:8424'; // admin configured, failing LLM stub
