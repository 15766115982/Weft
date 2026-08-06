# UI Portal Regression Test Plan — ADR-0009 role gating, chat IME, settings

Scope: regression coverage for the recent fixes — operator-only UI/API gating
(`ui/serve.mjs` `OPERATOR_GET_PATHS` + `requireAdmin`, `ui/public/app.js` `OPERATOR_ROUTES`),
the chat IME/Enter guard (`ui/public/views/chat.js`), and the settings page
(`ui/routes/api-settings.mjs` + `ui/public/js/settings.mjs`).

Two layers:

1. **API regression** — extends the existing `node:test` suites in `ui/test/`
   (run: `cd ui && node --test test/`). New file: `ui/test/authz.test.mjs`
   (role gating) plus additions to `ui/test/settings.test.mjs` and
   `ui/test/chat.test.mjs`.
2. **Browser regression** — new Playwright suite under `ui/e2e/`, added as a
   dev dependency (the UI has no build step; Playwright drives the real SPA).

Role matrix (ADR-0009): readers (no login) get Home/Browse/Search/Chat/Graph;
operators (single admin login) additionally get Decision Inbox (`#/queue`),
Upstream Detect (`#/upstream`), Govern (`#/govern`), Raw (`#/raw`),
Acquire (`#/acquire`), Settings (`/views/settings.html`).

## 1. Auth setup for tests

### 1a. API tests (`node:test`)

`lib/adminauth.mjs` reads `process.env.WEFT_ADMIN_PASSWORD_HASH` **at
`createPortal()` time**, so set the env var before creating the server:

```js
const PASSWORD = 'test-password-123';
process.env.WEFT_ADMIN_PASSWORD_HASH =
  crypto.createHash('sha256').update(PASSWORD, 'utf8').digest('hex');
// build scratch KB (see §4), then:
server = createPortal({ kb, port: 0 });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${server.address().port}`;
```

Obtain an operator session (cookie is `HttpOnly; SameSite=Strict`; `fetch`
in Node does not retain it — capture and replay manually):

```js
const res = await fetch(base + '/api/admin/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
});
const cookie = res.headers.get('set-cookie'); // "weft_session=...; HttpOnly; ..."
// pass on subsequent requests: fetch(url, { headers: { cookie } })
```

Write endpoints additionally need the per-startup UI token (S8): `GET /` and
extract `meta[name="ui-token"]`, then send it as the `x-ui-token` header.
Host must stay loopback (`127.0.0.1`); the default Node `fetch` Host header
already satisfies `auth.checkHost`.

The **unconfigured** scenario needs a second portal instance created with
`delete process.env.WEFT_ADMIN_PASSWORD_HASH` before `createPortal()` (the
hash is captured at construction, so toggling the env var afterwards has no
effect on an existing server).

### 1b. Playwright

- Add to `ui/package.json`:
  `"devDependencies": { "@playwright/test": "^1.x" }` and script
  `"test:e2e": "playwright test"`. Run: `cd ui && npx playwright test`
  (one-time `npx playwright install chromium`).
- `ui/e2e/playwright.config.mjs` `webServer`: spawn
  `node serve.mjs --kb <scratch-kb> --port 8322` with
  `env: { ...process.env, WEFT_ADMIN_PASSWORD_HASH: <sha256 of e2e password>, WEFT_LLM_CLI: <stub> }`,
  `baseURL: 'http://127.0.0.1:8322'`. Build the scratch KB in a Playwright
  **global setup** file (see §4) and pass its path via an env var.
- Login in tests through the real form: goto `/views/settings.html`, fill
  `#password`, submit `#login-form` — the `weft_session` cookie is then held
  by the browser context automatically. For operator-only cases that do not
  exercise the form, shortcut with `context.request.post('/api/admin/login')`
  (same origin, cookie lands in the context).
- Reader cases use a **fresh context with no cookie** (`browser.newContext()`)
  so the admin cookie never leaks in.
- A second config project (or a second webServer on port 8323) without
  `WEFT_ADMIN_PASSWORD_HASH` covers the "not configured" UI path.

## 2. API regression cases

Target: `ui/test/authz.test.mjs` (new). Harness per §1a. Operator GET set —
every path must be exercised in all three auth states:

`/api/settings`, `/api/plan`, `/api/conflicts`, `/api/decisions`, `/api/detect`,
`/api/rawlist`, `/api/raw`, `/api/raw-asset`, `/api/inbox`, `/api/sources`,
`/api/jobs`, `/api/diff`, `/api/kbfile`, `/api/history`, `/api/queue`

| # | Case | Endpoint / method | Auth | Expected |
|---|------|-------------------|------|----------|
| A1 | Session state, configured, logged out | GET `/api/session` | none | 200 `{ admin: false, configured: true }` |
| A2 | Session state after login | GET `/api/session` | admin cookie | 200 `{ admin: true, configured: true }` |
| A3 | Session state, unconfigured portal | GET `/api/session` | none (2nd portal) | 200 `{ admin: false, configured: false }` |
| A4 | Login wrong password | POST `/api/admin/login` | none | 401 `{ error: 'invalid password' }`, no `set-cookie` |
| A5 | Login on unconfigured portal | POST `/api/admin/login` | none (2nd portal) | 401 `{ error: /not configured/ }` |
| A6 | Login sets session cookie | POST `/api/admin/login` | correct password | 200, `set-cookie` matches `weft_session=.+; HttpOnly; Path=/; SameSite=Strict` |
| A7 | Logout invalidates session | POST `/api/admin/logout` then GET `/api/settings` | cookie, then replay same cookie | logout 200 with cleared cookie; settings → 401 |
| A8 | Operator GETs reject readers (parametrized over all 15 paths; supply required query params: `path=wiki/sources/a.md` for raw/diff/history, `path=GOVERNANCE.md` for kbfile, asset path for raw-asset) | GET each | none | 401 `{ error: 'admin session required' }` |
| A9 | Operator GETs reject when unconfigured (parametrized, 2nd portal) | GET each | none | 403 `{ error: /not configured/ }` — distinct from 401 so the UI can tell "log in" from "disabled" |
| A10 | Operator GETs succeed as admin (parametrized) | GET each | admin cookie | 200 and documented shape (e.g. `/api/queue` → `{ pages }` filtered to `status: candidate`; `/api/detect` → `{ connector, generated_at, detect }` null-shape when no report; `/api/settings` → `{ admin_configured, config, prompts, env }`) |
| A11 | Reader endpoints stay public (parametrized) | GET `/api/tree` `/api/health` `/api/page` `/api/backlinks` `/api/graph` `/api/rawrefs` `/api/search` `/api/log` `/api/feedback` `/api/govern-context` `/api/kbs` | none | 200 — guards against over-gating regressions |
| A12 | SSE stream stays open to readers | GET `/api/events` | none | 200 `text/event-stream`, first `: connected` comment line |
| S1 | Settings masks secrets | GET `/api/settings` | admin cookie | `config.auth.api_key === 'env:WEFT_LLM_API_KEY'` (masked), never the raw value |
| S2 | Settings without models.json | GET `/api/settings` | admin cookie | 200 `config: null`, `prompts: []` |
| S3 | Settings lists prompts | GET `/api/settings` | admin cookie | `prompts` entries `{ file, title, size }`, sorted, title from first `#` heading |
| S4 | Settings env flags | GET `/api/settings` | admin cookie | `env.WEFT_ADMIN_PASSWORD_HASH === true`, `env.KB_PATH` reflects harness |
| S5 | settings/check requires admin | POST `/api/settings/check` | none | 401 |
| S6 | settings/check enqueues job | POST `/api/settings/check` | admin cookie | 202 `{ job: { type: 'llm-check' } }` |
| S7 | init-prompts default vs force | POST `/api/settings/init-prompts` `{}` then `{ force: true }` | admin cookie | both 202 `type: 'llm-init-prompts'`; force flag propagated to job spec |
| C1 | Chat is a reader feature: no admin cookie needed | POST `/api/chat` | UI token only, no cookie | 200 SSE stream from stub LLM (meta/chunk/done lines) |
| C2 | Chat still requires the write token | POST `/api/chat` | no `x-ui-token` | 403 |
| C3 | Chat validates input | POST `/api/chat` `{ question: '' }` / missing | token | 400 `{ error: 'question required' }` |
| C4 | Chat level fallback | POST `/api/chat` `{ level: 'bogus' }` | token | stub receives `level: 'quick'` |
| C5 | Chat streams deep-research steps | POST `/api/chat` `{ level: 'deep' }` | token | SSE includes `search`/`read` step objects before `done` with `citations` |
| C6 | Chat child failure surfaces as SSE error | stub exits 1 | token | `event: error` frame, then `event: close`; no hang |
| G1 | **Known gap (documents current behavior, decide intent)**: mutating POSTs (`/api/review`, `/api/edit`, `/api/pull`, `/api/govern`, …) are token-gated only, not session-gated | POST `/api/review` | UI token, no admin cookie | currently 200. If ADR-0009 intends operator-only writes, this test should flip to expect 401 after a follow-up fix; record the decision in DEVLOG |

Notes for the harness: A8–A10 should loop over a table of
`[path, query]` pairs so a newly added operator endpoint that forgets to join
`OPERATOR_GET_PATHS` fails loudly (also add a guard test asserting every
`OPERATOR_GET_PATHS` entry appears in the table — drift protection).

## 3. Playwright UI cases

New suite `ui/e2e/` (config per §1b). `data-route` nav selectors are stable;
view-specific selectors below reference existing DOM
(`#login-section`, `#settings-section`, `.chat-input-row textarea`, …).

| # | Case | Steps | Expected |
|---|------|-------|----------|
| P1 | Reader nav is minimal | fresh context → goto `/` | nav links `queue/acquire/upstream/raw/govern` are `hidden`; `dashboard/browse/graph/search/chat` visible; stale banner hidden; no flash of operator links before `/api/session` resolves (assert hidden already at `domcontentloaded`) |
| P2 | Reader blocked from operator route | goto `/#/queue` (also `govern`, `raw`, `upstream`, `acquire`) | view shows "Operator login required" + "Go to Settings login" link; no queue API call issued (track requests: no 200 from `/api/queue`) |
| P3 | Unconfigured portal messaging | unconfigured project → goto `/#/queue` | "Operator features are disabled" + WEFT_ADMIN_PASSWORD_HASH hint; no login link |
| P4 | Login via settings form | goto `/views/settings.html` → wrong password → assert `#login-status` error → correct password | after correct login `#login-section` hidden, `#settings-section` visible, config JSON rendered, env list shows `WEFT_ADMIN_PASSWORD_HASH: ✅ set` |
| P5 | Settings shows model config + prompts | (seed `.kb/config/models.json` with `auth.api_key`, two prompt files) login → settings page | config code block contains masked `env:` value and never the raw key; prompts list shows both titles with file name + byte size; empty-state hint when prompts dir absent (separate run) |
| P6 | Login unlocks operator nav + routes | login via settings → goto `/` → reload | operator nav links visible; `/#/queue` renders the queue view (candidate page from fixture listed); `/#/govern`, `/#/raw`, `/#/upstream`, `/#/acquire` each render without the login gate |
| P7 | Session persists across reload; focus re-check | login, `page.reload()` | operator nav still visible after reload (cookie reused; `/api/session` → admin true) |
| P8 | Logout re-locks | settings → `#btn-logout` → goto `/` → reload | operator nav hidden again; `/#/queue` shows the login gate; `/api/settings` call 401s |
| P9 | Command palette role filter | reader: Ctrl+K | palette has 总览/浏览/图谱/检索/问答 + approved pages only — no 评审/采集/上游/来源/治理 actions, no candidate pages; operator: all five operator actions present, candidate pages listed |
| P10 | Operator hotkeys gated | reader: press `g` then `q` | hash unchanged (stays on current route); operator: lands on `/#/queue` |
| P11 | Chat Enter sends | stub LLM via `WEFT_LLM_CLI` → goto `/#/chat` → type "hello" → Enter | one POST `/api/chat`; user bubble appears; assistant bubble streams to "hello world"; citation link to `wiki/sources/x.md` rendered; input cleared and refocused |
| P12 | Chat Shift+Enter newline | type "line1" → Shift+Enter → type "line2" | no POST issued; textarea value contains `line1\nline2` |
| P13 | Chat IME composition Enter ignored | `page.evaluate` dispatch `new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })` on the textarea with text present | no POST `/api/chat` issued; textarea value unchanged (regression guard for the `e.isComposing` guard — Playwright cannot drive a real IME, so synthesize the event exactly as an IME would) |
| P14 | Chat level switch + empty input | click 深度 → Enter on empty input | level button `.on` moves to 深度; empty Enter sends nothing (no POST) |
| P15 | Chat stream failure surfaces | stub exits non-zero → send | assistant bubble shows the `流式输出失败` note; send button re-enabled; thinking indicator hidden |
| P16 | Reader header degrades silently on 401 `/api/jobs` | fresh context → goto `/` | page renders, no error banner from the header's unconditional `/api/jobs` poll (it 401s and is swallowed); documents current behavior — candidate follow-up: skip the poll when `!session.admin` |

## 4. Data construction

Shared fixture builder `ui/test/fixtures/kb.mjs` (new, used by both
`node:test` suites and the Playwright global setup). Build under
`fs.mkdtempSync(path.join(os.tmpdir(), 'kb-fixture-'))`; tear down in
`after()` / global teardown. Never commit to the fixture KB.

```
kb.json                       { "version": 2 }
raw/jira/PROJ-1.md            identity quintuple frontmatter (source: jira, source_id: PROJ-1, title, source_version, pulled_at)
raw/jira/PROJ-1.assets/diagram.png   tiny PNG (raw-asset case)
wiki/index.md                 status: approved (retrieval entry)
wiki/sources/jira-proj-1.md   status: approved, source_ref: raw/jira/PROJ-1.md
wiki/topics/alpha.md          status: candidate, sources: [raw/jira/PROJ-1.md]  (queue count = 1)
GOVERNANCE.md                 free-form markdown (kbfile case)
log.md                        2 lines matching "## [ts] actor | action | target | note"
.kb/config/models.json        { "default": "gpt-5.4", "auth": { "api_key": "WEFT_LLM_API_KEY" } }
.kb/config/prompts/chat.md    "# Chat prompt\n..."  (title extraction case)
.kb/config/prompts/govern.md  "# Govern prompt\n..."
.kb/acquire/upstream-detect.json  { ts, connector: 'jira', new: [...], changed: [], unchanged: [], removed_upstream: [], errors: [] }
.kb/govern/conflicts.json     one flagged group (conflicts endpoint non-empty shape)
.kb/govern/decisions.jsonl    2 decision records (decisions endpoint + filters)
```

LLM stub: reuse the `WEFT_LLM_CLI` stub pattern from `ui/test/chat.test.mjs`
(reads `--input-file`, writes fixed NDJSON meta/search/read/chunk×2/done to
`--output-file`). Playwright reuses the same stub file so browser streaming
cases (P11–P15) need no network and no real model.

Variant fixtures:

- **Unconfigured portal**: same KB, second server/config project without
  `WEFT_ADMIN_PASSWORD_HASH` (A3/A5/A9, P3).
- **No models.json / no prompts dir**: omit `.kb/config/` for S2 and the
  settings empty-state half of P5.
- **Failing LLM stub**: second stub that writes nothing and `process.exit(1)`
  for C6 / P15.

Playwright install note: `ui/package.json` currently has no dependencies;
adding `@playwright/test` as a devDependency is the first — keep it dev-only
(the portal itself stays dependency-free per the no-build-step rule), and
document `npx playwright install chromium` in `docs/installation.md` when the
suite lands.
