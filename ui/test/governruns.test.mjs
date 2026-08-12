// F1/F2 tests: wikiHash snapshot (F2), .kb/govern_runs.jsonl two-phase history
// with read-side interrupted inference (F1), governRunJob end-to-end recording
// via a fake executor (registerExecutor is the documented plug point), and the
// /api/health lastGovernRun extension.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createPortal } from '../serve.mjs';
import { registerExecutor } from '../lib/executor.mjs';
import { createJobCenter } from '../lib/jobs.mjs';
import { governRunJob, wikiHash } from '../lib/govern.mjs';
import { appendGovernRun, governRunFreshness, resumableGovernRun } from '../lib/governruns.mjs';

const write = (kb, rel, text) => {
  const abs = path.join(kb, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
};

function makeKb() {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-gruns-'));
  write(kb, 'wiki/syntheses/a.md', '---\ntype: topic\nstatus: approved\ntitle: A\n---\nBody A\n');
  write(kb, 'wiki/sources/local-x.md', '---\ntype: source\nstatus: approved\ntitle: X\n---\nBody X\n');
  return kb;
}

// ---- F2: wikiHash ----

test('wikiHash: stable for same tree, changes on 1-byte edit, null without wiki/', () => {
  const kb = makeKb();
  try {
    const h1 = wikiHash(kb);
    assert.ok(typeof h1 === 'string' && h1.length === 64);
    assert.equal(wikiHash(kb), h1);
    write(kb, 'wiki/syntheses/a.md', '---\ntype: topic\nstatus: approved\ntitle: A\n---\nBody A!\n');
    assert.notEqual(wikiHash(kb), h1);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-gruns-empty-'));
    try { assert.equal(wikiHash(empty), null); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  } finally {
    fs.rmSync(kb, { recursive: true, force: true });
  }
});

// ---- F1: append + freshness ----

test('governRunFreshness: interrupted / running / finish-status / last-per-id / torn lines', () => {
  const kb = makeKb();
  try {
    assert.equal(governRunFreshness(kb), null, 'no file → null');

    appendGovernRun(kb, { ts: '2026-08-03T10:00:00Z', jobId: 'j1', phase: 'start', executor: 'claude', promptHash: 'abc' });
    assert.equal(governRunFreshness(kb).status, 'interrupted', 'start-only, not active → interrupted');
    assert.equal(governRunFreshness(kb, new Set(['j1'])).status, 'running', 'start-only + active → running');

    appendGovernRun(kb, { ts: '2026-08-03T10:01:00Z', jobId: 'j1', phase: 'finish', status: 'complete', durationMs: 60000, noop: false, boundaryViolations: 0 });
    const f1 = governRunFreshness(kb);
    assert.equal(f1.status, 'complete');
    assert.equal(f1.durationMs, 60000);
    assert.equal(f1.startedAt, '2026-08-03T10:00:00Z');

    // a newer start-only job supersedes the older finished one
    appendGovernRun(kb, { ts: '2026-08-03T11:00:00Z', jobId: 'j2', phase: 'start', executor: 'claude', promptHash: 'def' });
    assert.equal(governRunFreshness(kb).status, 'interrupted');
    assert.equal(governRunFreshness(kb).jobId, 'j2');

    // torn trailing line is skipped without breaking earlier records
    fs.appendFileSync(path.join(kb, '.kb', 'govern_runs.jsonl'), '{"ts":"2026-08-03T12:00', 'utf8');
    assert.equal(governRunFreshness(kb).jobId, 'j2');
  } finally {
    fs.rmSync(kb, { recursive: true, force: true });
  }
});

// ---- F1+F2: governRunJob records start/finish through the serial queue ----

test('governRunJob: ok run records start+finish (noop true), writer run noop false, failure recorded', async () => {
  const kb = makeKb();
  const jobs = createJobCenter();
  try {
    registerExecutor('fake-noop', () => {
      const events = new EventEmitter();
      setTimeout(() => events.emit('done', { ok: true, text: 'nothing to do' }), 10);
      return { events, kill: () => {} };
    });
    registerExecutor('fake-writer', () => {
      const events = new EventEmitter();
      setTimeout(() => {
        write(kb, 'wiki/syntheses/b.md', '---\ntype: topic\nstatus: candidate\ntitle: B\n---\nBody B\n');
        events.emit('done', { ok: true, text: 'created topics/b' });
      }, 10);
      return { events, kill: () => {} };
    });
    registerExecutor('fake-fail', () => {
      const events = new EventEmitter();
      setTimeout(() => events.emit('done', { ok: false, text: 'boom' }), 10);
      return { events, kill: () => {} };
    });

    const j1 = jobs.enqueue(kb, governRunJob(kb, { prompt: 'run noop', executor: 'fake-noop' }));
    await jobs.waitFor(j1);
    assert.equal(j1.status, 'done');
    assert.equal(j1.result.noop, true, 'no wiki change → noop');
    assert.ok(j1.result.wikiHashBefore);

    const j2 = jobs.enqueue(kb, governRunJob(kb, { prompt: 'run writer', executor: 'fake-writer' }));
    await jobs.waitFor(j2);
    assert.equal(j2.status, 'done');
    assert.equal(j2.result.noop, false, 'wiki changed → not noop');
    assert.notEqual(j2.result.wikiHashAfter, j2.result.wikiHashBefore);

    const j3 = jobs.enqueue(kb, governRunJob(kb, { prompt: 'run fail', executor: 'fake-fail' }));
    await jobs.waitFor(j3);
    assert.equal(j3.status, 'failed');

    const recs = fs.readFileSync(path.join(kb, '.kb', 'govern_runs.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(recs.length, 6, 'three runs × start+finish');
    assert.deepEqual(recs.map((r) => r.phase), ['start', 'finish', 'start', 'finish', 'start', 'finish']);
    const byId = Object.fromEntries(recs.filter((r) => r.phase === 'finish').map((r) => [r.jobId, r]));
    assert.equal(byId[j1.id].status, 'complete');
    assert.equal(byId[j1.id].noop, true);
    assert.equal(byId[j2.id].noop, false);
    assert.equal(byId[j3.id].status, 'failed');
    assert.ok(byId[j1.id].durationMs >= 0);
    assert.ok('postPlanCounts' in byId[j1.id]);

    const fresh = governRunFreshness(kb);
    assert.equal(fresh.jobId, j3.id);
    assert.equal(fresh.status, 'failed');
  } finally {
    fs.rmSync(kb, { recursive: true, force: true });
  }
});

// ---- F4: post-run deterministic plan() attached to the job result ----

test('governRunJob: postPlan carries dangling links + counts; finish record has postPlanCounts', async () => {
  const kb = makeKb();
  const jobs = createJobCenter();
  try {
    registerExecutor('fake-dangler', () => {
      const events = new EventEmitter();
      setTimeout(() => {
        write(kb, 'wiki/syntheses/c.md', '---\ntype: topic\nstatus: candidate\ntitle: C\n---\nSee [[missing-page]].\n');
        events.emit('done', { ok: true, text: 'created topics/c with a bad link' });
      }, 10);
      return { events, kill: () => {} };
    });

    const j = jobs.enqueue(kb, governRunJob(kb, { prompt: 'run dangler', executor: 'fake-dangler' }));
    await jobs.waitFor(j);
    assert.equal(j.status, 'done');
    assert.ok(j.result.postPlan, 'postPlan attached on ok runs');
    assert.deepEqual(
      j.result.postPlan.dangling_links.map((d) => [d.page, d.link]),
      [['wiki/syntheses/c.md', 'missing-page']],
    );
    assert.equal(j.result.postPlan.counts.dangling_links, 1);
    assert.ok(typeof j.result.postPlan.counts.errors === 'number');

    const finish = fs.readFileSync(path.join(kb, '.kb', 'govern_runs.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.phase === 'finish');
    assert.equal(finish.postPlanCounts.dangling_links, 1, 'F1 finish record carries F4 counts');

    // failed runs carry no postPlan (partial changes surface via live /api/plan instead)
    registerExecutor('fake-fail2', () => {
      const events = new EventEmitter();
      setTimeout(() => events.emit('done', { ok: false, text: 'boom' }), 10);
      return { events, kill: () => {} };
    });
    const j2 = jobs.enqueue(kb, governRunJob(kb, { prompt: 'run fail2', executor: 'fake-fail2' }));
    await jobs.waitFor(j2);
    assert.equal(j2.status, 'failed');
  } finally {
    fs.rmSync(kb, { recursive: true, force: true });
  }
});

// ---- one commit per governance run (CONTEXT.md:190; N3/N5 of the review-fix
// review: auto-commit needs assertions, and pre-dirty user files must not be
// swept into a governance commit) ----

test('governRunJob: git KB auto-commits run changes; pre-dirty user file untouched; noop run commits nothing', async (t) => {
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); }
  catch { t.skip('git not available in this environment'); return; }
  const kb = makeKb();
  const jobs = createJobCenter();
  const git = (args) => execFileSync('git', ['-C', kb, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    git(['init', '-q']);
    git(['add', '-A']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
    // the user's own uncommitted work, dirty BEFORE the run — never the
    // governance commit's business
    write(kb, 'wiki/syntheses/user-draft.md', '---\ntype: topic\nstatus: candidate\ntitle: Draft\n---\nuser work\n');

    registerExecutor('fake-git-writer', () => {
      const events = new EventEmitter();
      setTimeout(() => {
        write(kb, 'wiki/syntheses/b.md', '---\ntype: topic\nstatus: candidate\ntitle: B\n---\nBody B\n');
        events.emit('done', { ok: true, text: 'created topics/b' });
      }, 10);
      return { events, kill: () => {} };
    });

    const j1 = jobs.enqueue(kb, governRunJob(kb, { prompt: 'run writer', executor: 'fake-git-writer' }));
    await jobs.waitFor(j1);
    assert.equal(j1.status, 'done');
    assert.equal(j1.result.gitCommitted, true, 'run changes committed');
    const log = git(['log', '--format=%s | %an']);
    assert.match(log, /govern: agent run .* \| kb-portal/);
    const dirty = git(['status', '--porcelain']);
    assert.ok(!dirty.includes('wiki/syntheses/b.md'), 'run output is committed, not dirty');
    assert.match(dirty, /user-draft\.md/, 'pre-dirty user file stays uncommitted');

    const finish = fs.readFileSync(path.join(kb, '.kb', 'govern_runs.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.phase === 'finish');
    assert.equal(finish.gitCommitted, true, 'F1 finish record carries the commit flag');
    assert.notEqual(finish.gitHeadAfter, finish.gitHeadBefore, 'HEAD moved by the run commit');

    // a no-change run on a git KB: committed=false, no new commit
    const headBefore = git(['rev-parse', 'HEAD']).trim();
    const j2 = jobs.enqueue(kb, governRunJob(kb, { prompt: 'run noop', executor: 'fake-noop' }));
    await jobs.waitFor(j2);
    assert.equal(j2.result.gitCommitted, false);
    assert.equal(git(['rev-parse', 'HEAD']).trim(), headBefore, 'noop run creates no commit');
  } finally {
    fs.rmSync(kb, { recursive: true, force: true });
  }
});

test('governRunJob: non-git KB omits gitCommitted (S4 silent skip)', async () => {
  const kb = makeKb(); // not a git repo
  const jobs = createJobCenter();
  try {
    const j = jobs.enqueue(kb, governRunJob(kb, { prompt: 'run noop', executor: 'fake-noop' }));
    await jobs.waitFor(j);
    assert.equal(j.status, 'done');
    assert.ok(!('gitCommitted' in j.result), 'non-git KB: no commit field at all');
  } finally {
    fs.rmSync(kb, { recursive: true, force: true });
  }
});

// ---- F1: /api/health carries lastGovernRun ----

test('/api/health exposes lastGovernRun after a portal agent run', async () => {
  const kb = makeKb();
  const server = createPortal({ kb, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(base + '/')).text();
    const token = page.match(/name="ui-token" content="([^"]+)"/)[1];

    let h = await (await fetch(base + '/api/health')).json();
    assert.equal(h.lastGovernRun, null, 'no runs yet');

    const res = await fetch(base + '/api/govern-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ui-token': token, origin: base },
      body: JSON.stringify({ prompt: 'portal run', executor: 'fake-noop' }),
    });
    assert.equal(res.status, 202);
    const { job } = await res.json();
    // poll until terminal
    for (;;) {
      const { jobs: list } = await (await fetch(base + '/api/jobs')).json();
      const j = list.find((x) => x.id === job.id);
      if (j.status === 'done' || j.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    h = await (await fetch(base + '/api/health')).json();
    assert.equal(h.lastGovernRun.status, 'complete');
    assert.equal(h.lastGovernRun.noop, true);
  } finally {
    server.close();
    fs.rmSync(kb, { recursive: true, force: true });
  }
});

// ---- 2026-08-12: checkpoint resume wiring ----

test('resumableGovernRun: interrupted/failed/cancelled resumable; complete/resumed not; threadId rides the start record', () => {
  const kb = makeKb();
  try {
    assert.equal(resumableGovernRun(kb), null, 'no history → null');
    appendGovernRun(kb, { ts: '2026-08-12T10:00:00Z', jobId: 'done1', phase: 'start' });
    appendGovernRun(kb, { ts: '2026-08-12T10:05:00Z', jobId: 'done1', phase: 'finish', status: 'complete' });
    assert.equal(resumableGovernRun(kb), null, 'completed runs delete their thread — not resumable');

    appendGovernRun(kb, { ts: '2026-08-12T11:00:00Z', jobId: 'dead1', phase: 'start' });
    const r1 = resumableGovernRun(kb);
    assert.equal(r1.threadId, 'portal-dead1', 'legacy record without threadId falls back to portal-<jobId>');
    assert.equal(r1.status, 'interrupted');

    // a failed resume run points at the ORIGINAL thread via its start record
    appendGovernRun(kb, { ts: '2026-08-12T12:00:00Z', jobId: 'retry1', phase: 'start', threadId: 'portal-dead1' });
    appendGovernRun(kb, { ts: '2026-08-12T12:01:00Z', jobId: 'retry1', phase: 'finish', status: 'failed' });
    const r2 = resumableGovernRun(kb);
    assert.equal(r2.jobId, 'retry1', 'the newer resumable job wins');
    assert.equal(r2.threadId, 'portal-dead1', 'thread id survives across the resume chain');

    appendGovernRun(kb, { ts: '2026-08-12T12:02:00Z', jobId: 'dead1', phase: 'finish', status: 'resumed', resumedBy: 'retry1' });
    const r3 = resumableGovernRun(kb);
    assert.equal(r3.jobId, 'retry1', 'a resumed-away run is no longer resumable itself');

    assert.equal(resumableGovernRun(kb, 'retry1'), null, 'excludeJobId skips the running job');
  } finally {
    fs.rmSync(kb, { recursive: true, force: true });
  }
});

test('governRunJob resume:true hands the checkpoint thread to the executor and closes the old run', async () => {
  const kb = makeKb();
  const jobs = createJobCenter();
  try {
    appendGovernRun(kb, { ts: '2026-08-12T09:00:00Z', jobId: 'old9', phase: 'start' });
    let seen = null;
    registerExecutor('fake-capture', (spec) => {
      seen = spec;
      const events = new EventEmitter();
      setTimeout(() => events.emit('done', { ok: true, text: 'resumed run finished' }), 10);
      return { events, kill: () => {} };
    });
    const j = jobs.enqueue(kb, governRunJob(kb, { prompt: 'x', executor: 'fake-capture', resume: true }));
    await jobs.waitFor(j);
    assert.equal(j.status, 'done', JSON.stringify(j.error));
    assert.equal(seen.resumeThreadId, 'portal-old9', 'executor receives the interrupted run\'s thread');

    const fresh = governRunFreshness(kb);
    assert.equal(fresh.status, 'complete');
    // old run closed as resumed; nothing left to resume
    assert.equal(resumableGovernRun(kb), null, 'completed resume closes the chain');
  } finally {
    fs.rmSync(kb, { recursive: true, force: true });
  }
});

test('governRunJob resume:true with nothing resumable starts fresh and says so', async () => {
  const kb = makeKb();
  const jobs = createJobCenter();
  try {
    let seen = null;
    registerExecutor('fake-capture2', (spec) => {
      seen = spec;
      const events = new EventEmitter();
      setTimeout(() => events.emit('done', { ok: true, text: 'fresh' }), 10);
      return { events, kill: () => {} };
    });
    const j = jobs.enqueue(kb, governRunJob(kb, { prompt: 'x', executor: 'fake-capture2', resume: true }));
    await jobs.waitFor(j);
    assert.equal(j.status, 'done');
    assert.equal(seen.resumeThreadId, null);
    assert.match(j.log, /没有可续跑/);
  } finally {
    fs.rmSync(kb, { recursive: true, force: true });
  }
});
