// Remove the scratch e2e fixture KB after the run.
import fs from 'node:fs';
import { E2E_ROOT } from './paths.mjs';

export default async function globalTeardown() {
  fs.rmSync(E2E_ROOT, { recursive: true, force: true });
}
