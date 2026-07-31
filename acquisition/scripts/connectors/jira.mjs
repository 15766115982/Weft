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
 *  text keeps its source language — raw/ is the evidence layer). */
export function issueToMarkdown(issue, baseUrl) {
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
  return head.join('\n') + '\n';
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
  return { ...auth, jqlList, max };
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

  for (const [key, issue] of byKey) {
    if (!SAFE_SOURCE_ID.test(key)) {
      summary.errors.push({ key, error: `non-compliant issue key (contract §2): ${key}` });
      continue;
    }
    try {
      const f = issue.fields || {};
      const body = issueToMarkdown(issue, cfg.baseUrl);
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
  return summary;
}
