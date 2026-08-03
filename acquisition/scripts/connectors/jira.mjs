// Jira connector (contract §1 raw/jira/<issue-key>.md, §2 spec, §6 kb.json).
// Jira Server / Data Center PAT auth: Authorization: Bearer <pat>
// (Jira Cloud email+API-token Basic auth is out of scope).
//
// Config (kb.json, secrets by env-var NAME only — the PAT itself never
// touches disk, logs, or error messages):
//   "connectors": { "jira": {
//     "base_url": "https://jira.example.com",
//     "pat_env": "JIRA_PAT",
//     "jql": ["project = PROJ ORDER BY updated DESC"]
//   } }
//
// The old Python reference (LLM-Wiki backend/app/jira.py) is logic reference
// only; this is a from-scratch Node rewrite on the global fetch (Node >= 18).
import { upsertRawDoc, sha256 } from '../lib/rawdoc.mjs';
import { appendLog } from '../lib/log.mjs';
import { describeShape, shapeError } from '../lib/shape.mjs';

export const CONNECTOR_ID = 'jira@1.0.0';

const ISSUE_FIELDS = [
  'summary', 'description', 'status', 'issuetype', 'priority', 'labels',
  'components', 'assignee', 'reporter', 'created', 'updated', 'comment',
  'fixVersions',
];
const PAGE_SIZE = 50;
const MAX_COMMENTS = 10; // most recent N, guards against oversized bodies
const REQUEST_TIMEOUT_MS = 30_000;
// contract §2: source/source_id are spliced into wiki paths, so they are
// whitelisted; a non-compliant Jira key is skipped with an error, never escaped
const SAFE_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function person(p) {
  return p?.displayName || p?.name || '';
}

/** Jira Server emits "+0800" offsets; normalize to strict ISO 8601.
 *  Unparseable values pass through unchanged (kept visible, not invented). */
export function normalizeJiraDate(s) {
  if (!s) return '';
  const fixed = String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(fixed);
  return Number.isNaN(d.getTime()) ? String(s) : d.toISOString();
}

/** Minimal ADF (Jira Cloud rich text) → plain text fallback; Server/DC
 *  descriptions are already plain strings and pass through untouched. */
export function adfToText(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object') {
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'mention') return node.attrs?.text || '';
    const parts = [adfToText(node.text || '')];
    for (const child of node.content || []) parts.push(adfToText(child));
    const sep = ['paragraph', 'heading', 'bulletList', 'orderedList', 'codeBlock', 'listItem']
      .includes(node.type) ? '\n' : '';
    return sep + parts.filter(Boolean).join(sep);
  }
  return '';
}

/** One issue -> normalized markdown body (English scaffold; the issue's own
 *  text keeps its source language — raw/ is the evidence layer).
 *  opts.testSteps: parsed Zephyr steps (parseTestSteps output); appended as a
 *  table after Comments so steps ride the content_hash incremental semantics. */
export function issueToMarkdown(issue, baseUrl, { testSteps } = {}) {
  const key = issue.key || '';
  const f = issue.fields || {};
  const summary = f.summary || '';
  const status = f.status?.name || '';
  const itype = f.issuetype?.name || '';
  const priority = f.priority?.name || '';
  const labels = f.labels || [];
  const components = (f.components || []).map((c) => c.name || '');
  const description = adfToText(f.description).trim();
  // full-precision timestamps: the body is what content_hash covers, and Jira
  // bumps `updated` on EVERY edit — a day-granularity date here would make
  // same-day second edits invisible to the incremental skip
  const created = normalizeJiraDate(f.created);
  const updated = normalizeJiraDate(f.updated);

  const head = [
    `# [${key}] ${summary}`,
    '',
    `- Link: ${baseUrl}/browse/${key}`,
    `- Type: ${itype}  Status: ${status}  Priority: ${priority}`,
    `- Reporter: ${person(f.reporter)}  Assignee: ${person(f.assignee)}`,
    `- Created: ${created}  Updated: ${updated}`,
  ];
  if (labels.length || components.length) {
    head.push(`- Labels: ${labels.join(', ')}  Components: ${components.join(', ')}`);
  }
  head.push('', '## Description', '', description || '(no description)');

  const comments = f.comment?.comments || [];
  const blocks = [];
  for (const cm of comments.slice(-MAX_COMMENTS)) {
    const body = adfToText(cm.body).trim();
    if (body) {
      blocks.push(`> **${person(cm.author)}** (${(cm.created || '').slice(0, 10)}):\n> ${body.replace(/\n/g, '\n> ')}`);
    }
  }
  if (blocks.length) head.push('', '## Comments', '', blocks.join('\n\n'));
  const stepsMd = testStepsToMarkdown(testSteps);
  if (stepsMd) head.push('', stepsMd);
  return head.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Zephyr Squad test steps (2026-08-03 phase 1)
// Steps live in Zephyr's own tables — NO Jira field expansion can reach them;
// the only way in is ZAPI: GET /rest/zapi/latest/teststep/{issueId} with the
// same PAT. Zephyr Scale (/rest/atm/...) is a different product, phase 2+.
// ---------------------------------------------------------------------------

const ZAPI_TIMEOUT_MS = 30_000;

function decodeBasicEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // must run last
}

/** ZAPI teststep JSON -> [{n, step, data, result}] ordered by orderId.
 *  Shape-tolerant (only the relayed error text may cross the intranet border):
 *  plain step/data/result first, tag-stripped html* variants as fallback. */
export function parseTestSteps(data) {
  if (!Array.isArray(data)) throw shapeError('zapi teststep response', 'array', data);
  const cell = (item, plain, html) => {
    const v = item?.[plain];
    if (typeof v === 'string' && v.trim()) return v.trim();
    const h = item?.[html];
    if (typeof h === 'string' && h.trim()) {
      return decodeBasicEntities(h.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    }
    return '';
  };
  return data
    .map((item, i) => ({
      orderId: Number.isInteger(item?.orderId) ? item.orderId : i + 1,
      step: cell(item, 'step', 'htmlStep'),
      data: cell(item, 'data', 'htmlData'),
      result: cell(item, 'result', 'htmlResult'),
      _i: i,
    }))
    .sort((a, b) => a.orderId - b.orderId || a._i - b._i)
    .map(({ _i, ...rest }, n) => ({ n: n + 1, ...rest }));
}

export function testStepsToMarkdown(steps) {
  if (!steps?.length) return '';
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
  return [
    '## Test Steps',
    '',
    '| # | Step | Test Data | Expected Result |',
    '|---|------|-----------|-----------------|',
    ...steps.map((s) => `| ${s.n} | ${cell(s.step)} | ${cell(s.data)} | ${cell(s.result)} |`),
  ].join('\n');
}

/** ZAPI fetch — deliberately NOT jiraGet: jiraGet treats 403 as global
 *  authFailed (fail-fast across scopes), but a ZAPI 403/404 in auto mode only
 *  means "plugin absent", which must degrade, never kill the pull. */
async function fetchTestSteps(cfg, issueId, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(`${cfg.baseUrl}/rest/zapi/latest/teststep/${issueId}`, {
    headers: { Authorization: `Bearer ${cfg.pat}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(ZAPI_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) {
    const err = new Error(`zapi teststep HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Opportunistic Zephyr Scale detection (squad probe 404'd): returns the HTTP
 *  status of the Scale endpoint (0 on network error) — 200 means the intranet
 *  runs Scale, whose adaptation is a different (phase 2+) job. */
async function probeScale(cfg, issueKey, fetchImpl) {
  try {
    const doFetch = fetchImpl || globalThis.fetch;
    const res = await doFetch(`${cfg.baseUrl}/rest/atm/1.0/testcase/${encodeURIComponent(issueKey)}`, {
      headers: { Authorization: `Bearer ${cfg.pat}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(ZAPI_TIMEOUT_MS),
      redirect: 'follow',
    });
    return res.status;
  } catch {
    return 0;
  }
}

/** Shape probe (acquire.mjs `jira --probe`): fetch ONE Test issue's ZAPI
 *  response and report its structure — types/key names/counts, never values,
 *  so the output is safe to relay out of the intranet verbatim. */
export async function probeZephyr(kbConfig, { fetchImpl } = {}) {
  const cfg = resolveConfig(kbConfig, { maxResults: 1 });
  const type = cfg.testIssueTypes[0];
  // user JQL may end with ORDER BY — the type filter must go before it
  const [head, tail] = cfg.jqlList[0].split(/\s+ORDER\s+BY\s+/i);
  const jql = `${head} AND issuetype = "${type}"${tail ? ` ORDER BY ${tail}` : ''}`;
  const { issues } = await searchAll({ ...cfg, max: 1 }, jql, fetchImpl);
  if (!issues.length) return { probe: true, note: 'no-test-issue-found', jql };
  const issue = issues[0];
  const out = { probe: true, issue_key: issue.key || '', jql };
  try {
    const steps = await fetchTestSteps(cfg, issue.id, fetchImpl);
    const d = describeShape(steps);
    out.zephyr = {
      http: 200,
      isArray: d.type === 'array',
      count: d.length ?? null,
      firstItemKeys: d.keys || [],
    };
  } catch (err) {
    out.zephyr = { http: err.status || 0, error: err.message };
    out.scale = { http: await probeScale(cfg, issue.key, fetchImpl) };
  }
  return out;
}

/** Shared auth/config resolution for run() and check() — one reading
 *  convention, so future rules (e.g. a new required field) cannot drift
 *  between the two entry points. */
function resolveAuth(kbConfig) {
  const j = kbConfig?.connectors?.jira || {};
  if (!j.base_url) {
    throw new Error('jira connector is not configured: set connectors.jira.base_url in kb.json');
  }
  const patEnv = j.pat_env || 'JIRA_PAT';
  const pat = process.env[patEnv];
  if (!pat) {
    throw new Error(`jira PAT not available: environment variable ${patEnv} is not set (kb.json connectors.jira.pat_env)`);
  }
  return { baseUrl: String(j.base_url).replace(/\/+$/, ''), pat, patEnv, jiraConf: j };
}

function resolveConfig(kbConfig, { jql, maxResults } = {}) {
  const auth = resolveAuth(kbConfig);
  const j = auth.jiraConf;
  const jqlList = jql ? [jql] : (Array.isArray(j.jql) ? j.jql : j.jql ? [j.jql] : []);
  if (!jqlList.length) {
    throw new Error('no JQL scope: pass --jql or set connectors.jira.jql in kb.json');
  }
  let max = maxResults === undefined ? 200 : Number(maxResults);
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error(`--max must be a positive integer (got ${JSON.stringify(maxResults)})`);
  }
  // Zephyr (phase 1): 'auto' probes once per run, true forces, false disables
  const zephyr = j.zephyr === undefined ? 'auto' : j.zephyr;
  if (!(zephyr === 'auto' || zephyr === true || zephyr === false)) {
    throw new Error(`connectors.jira.zephyr must be "auto" | true | false (got ${JSON.stringify(j.zephyr)})`);
  }
  const testIssueTypes = j.test_issue_types === undefined ? ['Test'] : j.test_issue_types;
  if (!Array.isArray(testIssueTypes) || testIssueTypes.some((t) => typeof t !== 'string' || !t)) {
    throw new Error('connectors.jira.test_issue_types must be an array of non-empty strings');
  }
  return { ...auth, jqlList, max, zephyr, testIssueTypes };
}

async function jiraGet(cfg, pathAndQuery, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(cfg.baseUrl + pathAndQuery, {
    headers: { Authorization: `Bearer ${cfg.pat}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`jira authentication failed HTTP ${res.status}: check the PAT in env var ${cfg.patEnv}`);
    err.authFailed = true; // every scope would fail identically — callers fail fast
    throw err;
  }
  if (!res.ok) {
    const snippet = await res.text().catch(() => '');
    throw new Error(`jira request failed HTTP ${res.status}: ${snippet.slice(0, 300)}`);
  }
  return res.json();
}

/** PAT sanity check: GET /rest/api/2/myself. */
export async function check(kbConfig, { fetchImpl } = {}) {
  const auth = resolveAuth(kbConfig);
  const me = await jiraGet(auth, '/rest/api/2/myself', fetchImpl);
  return { name: me.name || '', displayName: me.displayName || '', emailAddress: me.emailAddress || '' };
}

/** Reusable JQL search for external callers (the Confluence jira-filter macro
 *  resolver). Returns {issues, total} like searchAll, capped at max. */
export async function searchJql(kbConfig, jql, { max = 20, fetchImpl } = {}) {
  const auth = resolveAuth(kbConfig);
  return searchAll({ ...auth, max }, String(jql), fetchImpl);
}

/** Single issue by key, minimal fields (jira-filter macro `key` parameter). */
export async function getIssue(kbConfig, key, { fetchImpl } = {}) {
  const auth = resolveAuth(kbConfig);
  const q = new URLSearchParams({ fields: 'summary,status,assignee' });
  return jiraGet(auth, `/rest/api/2/issue/${encodeURIComponent(String(key))}?${q}`, fetchImpl);
}

/** JQL search with startAt/maxResults pagination (per-JQL cap = cfg.max).
 *  @returns {issues, total} — total is the server-reported hit count, so the
 *  caller can surface truncation instead of letting it look complete. */
async function searchAll(cfg, jql, fetchImpl) {
  const issues = [];
  let startAt = 0;
  let total = null;
  for (;;) {
    const want = Math.min(PAGE_SIZE, cfg.max - issues.length);
    if (want <= 0) break;
    const q = new URLSearchParams({
      jql, startAt: String(startAt), maxResults: String(want), fields: ISSUE_FIELDS.join(','),
    });
    const data = await jiraGet(cfg, `/rest/api/2/search?${q}`, fetchImpl);
    const batch = data.issues || [];
    issues.push(...batch);
    total = data.total ?? issues.length;
    if (batch.length < want || issues.length >= total) break;
    startAt += batch.length;
  }
  return { issues, total: total ?? issues.length };
}

/**
 * Pull every configured JQL scope into raw/jira/<KEY>.md.
 * An issue matched by several JQLs is written once (keyed dedupe).
 * @returns summary {created, updated, unchanged, errors, total}
 */
export async function run(kbRoot, { kbConfig, jql, maxResults, fetchImpl } = {}) {
  const cfg = resolveConfig(kbConfig, { jql, maxResults });
  const summary = { created: [], updated: [], unchanged: [], errors: [], truncated: [], total: 0 };

  const byKey = new Map();
  for (const scope of cfg.jqlList) {
    let res;
    try {
      res = await searchAll(cfg, scope, fetchImpl);
    } catch (err) {
      if (err.authFailed) throw err; // fail fast: every scope would fail identically
      // per-scope failure granularity matches per-issue: record and continue
      summary.errors.push({ jql: scope, error: err.message });
      continue;
    }
    if (res.total > res.issues.length) {
      summary.truncated.push({ jql: scope, fetched: res.issues.length, total: res.total });
    }
    for (const issue of res.issues) {
      if (issue?.key && !byKey.has(issue.key)) byKey.set(issue.key, issue);
    }
  }
  summary.total = byKey.size;

  // Zephyr state for this run: 'auto' starts undecided and probes on the
  // first Test-type issue only; forced true is available from the start
  const testTypes = new Set(cfg.testIssueTypes);
  let zephyrAvailable = cfg.zephyr === true;
  let zephyrState = cfg.zephyr === false ? 'disabled' : null;
  let probed = false;
  let sawTestIssue = false;
  let totalSteps = 0;

  for (const [key, issue] of byKey) {
    if (!SAFE_SOURCE_ID.test(key)) {
      summary.errors.push({ key, error: `non-compliant issue key (contract §2): ${key}` });
      continue;
    }
    try {
      const f = issue.fields || {};

      // Zephyr steps: ZAPI takes the numeric issue.id, NOT the key
      const isTest = testTypes.has(f.issuetype?.name || '');
      let testSteps = null;
      if (isTest) {
        sawTestIssue = true;
        if (cfg.zephyr !== false && (zephyrAvailable || (cfg.zephyr === 'auto' && !probed))) {
          try {
            testSteps = parseTestSteps(await fetchTestSteps(cfg, issue.id, fetchImpl));
            totalSteps += testSteps.length;
            if (!zephyrAvailable) { zephyrAvailable = true; zephyrState = 'available'; }
          } catch (err) {
            if (cfg.zephyr === 'auto' && !probed && (err.status === 404 || err.status === 403)) {
              // plugin absent (or no permission): degrade to plain issue = pre-phase-1 behavior
              zephyrState = 'unavailable';
              if ((await probeScale(cfg, key, fetchImpl)) === 200) {
                summary.zephyr_hint = 'Zephyr Scale endpoint detected (/rest/atm); Squad steps unavailable — Scale adaptation is phase 2+';
              }
            } else {
              summary.errors.push({ key, error: `zephyr steps: ${err.message}` });
            }
          }
          if (cfg.zephyr === 'auto') probed = true;
        }
      }

      const body = issueToMarkdown(issue, cfg.baseUrl, { testSteps });
      const result = upsertRawDoc(kbRoot, {
        source: 'jira',
        sourceId: key,
        fileName: `${key}.md`,
        sourceUrl: `${cfg.baseUrl}/browse/${key}`,
        sourceVersion: normalizeJiraDate(f.updated),
        title: `[${key}] ${f.summary || ''}`,
        connector: CONNECTOR_ID,
        extra: {
          issue_type: f.issuetype?.name || '',
          status: f.status?.name || '',
          priority: f.priority?.name || '',
          assignee: person(f.assignee),
          reporter: person(f.reporter),
          labels: (f.labels || []).join(', '),
          components: (f.components || []).map((c) => c.name || '').join(', '),
          fix_versions: (f.fixVersions || []).map((v) => v.name || '').join(', '),
          ...(testSteps?.length ? { test_steps: String(testSteps.length) } : {}),
        },
        contentHash: sha256(body),
        body,
      });
      const rel = result.relPath.replace(/\\/g, '/');
      summary[result.action === 'created' ? 'created' : result.action === 'updated' ? 'updated' : 'unchanged'].push(rel);
      if (result.action !== 'unchanged') {
        appendLog(kbRoot, 'acquire', `jira:${result.action}`, rel, `key ${key}`);
      }
    } catch (err) {
      summary.errors.push({ key, error: err.message });
    }
  }
  // field omitted entirely when no Test-type issue was seen (Bug-only scopes
  // stay exactly as before); first post-upgrade run re-hashes every Test
  // issue (new body section) — one expected "updated" wave
  if (sawTestIssue) {
    summary.zephyr = cfg.zephyr === false ? 'disabled' : zephyrState || (zephyrAvailable ? 'available' : 'unavailable');
  }
  if (totalSteps) summary.test_steps = totalSteps;
  return summary;
}
