// KB registry + per-request KB resolution (S9, J1 KB switcher).
// The registry file lives on the code-repo side (ui/kbs.json), never inside a KB:
//   { "kbs": [{ "name": "work", "path": "D:/kb/work" }] }
// --kb <path> / KB_PATH are registered implicitly as "default".
// The server holds no global KB state — every request resolves its own ?kb=.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kbs.json');

export function createKbRegistry({ cliKb } = {}) {
  const kbs = [];
  if (cliKb) kbs.push({ name: 'default', path: path.resolve(cliKb) });
  if (fs.existsSync(REGISTRY_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
      for (const e of parsed.kbs || []) {
        if (e && e.name && e.path && !kbs.some((k) => k.name === e.name)) {
          kbs.push({ name: String(e.name), path: path.resolve(e.path) });
        }
      }
    } catch (err) {
      console.error(`warning: ignoring malformed ui/kbs.json: ${err.message}`);
    }
  }
  // P1-5: dedupe by resolved path — a cliKb also registered in kbs.json keeps
  // the kbs.json name (more meaningful than "default").
  const byPath = new Map();
  for (const k of kbs) {
    const key = process.platform === 'win32' ? k.path.toLowerCase() : k.path;
    if (byPath.has(key)) byPath.get(key).name = k.name; // later (kbs.json) name wins
    else byPath.set(key, k);
  }
  kbs.length = 0;
  kbs.push(...byPath.values());

  const list = () => kbs.map((k) => ({ name: k.name, path: k.path, exists: fs.existsSync(k.path) }));

  // param: ?kb=<name>; falls back to the first registered KB.
  function resolve(param) {
    const entry = param ? kbs.find((k) => k.name === param) : kbs[0];
    if (!entry) throw Object.assign(new Error(`unknown KB: ${param ?? '(none registered)'}`), { code: 400 });
    if (!fs.existsSync(entry.path)) throw Object.assign(new Error(`KB path does not exist: ${entry.path}`), { code: 400 });
    return entry;
  }

  return { list, resolve };
}
