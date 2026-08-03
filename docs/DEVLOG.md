# Development Log (as of 2026-08-03, M0-M6 complete + cross-service test layer + M7a-d UI portal + A7 graph)

> Restart entry point after context compaction. Architecture decisions: `CONTEXT.md`;
> three-party contract: `schema/contract.md` + `schema/governance.md` (§1 language
> convention: wiki all-English, raw keeps source language); six ADRs in `docs/adr/`.
> **New-deployment entry: `docs/installation.md` (+ `installation.zh-CN.md` 中文版)** —
> prerequisites, skill linking, kb.json/PAT/CA configuration, smoke test, troubleshooting.
> **M7 UI portal: process + design docs in `docs/webui/`** (requirements frozen, option 1
> no-build SPA selected, ADR-0006, contract §1 UI-portal column, S7 spike report).

## K phase 1 (2026-08-03, 54 UI tests green + real-claude smoke): LLM judge + async badge

Block K direction was already ruled in requirements (self-built lightweight judge,
zero Python); this is phase 1: K1 badge + K3 registry with its first adapter.

- **ui/lib/judge.mjs — the judge half of the "LLM backend registry"** (M7c
  reviewer note): registerJudge(name, chatFn) mirrors executor.mjs's
  registerExecutor — executor = name→startRun, judge = name→chat→text, same
  plug-point discipline (tests register 'mock' through the same path).
  First adapter `claude`: claude.cmd -p, prompt via stdin, **tools disabled
  (--disallowedTools)** — the judge's input is untrusted KB content, so it
  must not have a filesystem; output is display-only. copilot-proxy / Azure
  SPN adapters plug in here once their endpoints are verified (still 待验证
  in requirements since 2026-08-02).
- **K2 scope note**: fixed rubric (0-3 pointwise + ≤15-word reason), ONE call
  for all top-5 (not five serial calls). **Promptfoo CI deliberately not
  vendored** (heavy npm dep, intranet rule) — the existing tests/eval
  Hit@5=1.000 gate stays the CI regression; judge calibration vs the golden
  set (K4) is a manual run, recorded as a leftover.
- **/api/judge**: read-only → off-queue (authCheck precedent); q + ≤10 results
  validation; parseVerdicts tolerates prose around the JSON array, clamps
  scores to 0-3, and marks unjudged slots null instead of failing.
- **search view (K1)**: results render immediately; top-5 cards get a pending
  chip, the badge (3 pine / 2 celadon / 1 amber / 0 wine) lands when the judge
  returns, tooltip = reason + backend + latency; head line gains judge timing.
  Same seq race guard as the search itself.
- Real-claude smoke (demo KB, "retry compensation"): 5 verdicts with sensible
  gradation (saga compensation page = 3, adjacent pages = 1-2), 26.1s batched
  latency — the async badge absorbs it. Zero JS errors.

## C5 (2026-08-03, 49 UI tests green): batch review — first backlog item

User ruling 2026-08-03 (AskUserQuestion, requirements 排期记录 C5 "需详细讨论" 的落地):
checkboxes + select-all;approve DIRECT (recoverable via M7d edit-demote);reject =
armed two-click + archive consequence copy (merge-topic discipline).Final-review
guidance adopted:approve/reject treated as different cost classes.

- **/api/review-batch**: one queued job (S10), per-page statusflip with per-page
  fault isolation — a 409-lost page (or traversal, or missing page) is recorded in
  that page's result slot and never aborts the batch; the job itself only fails on
  wholesale errors. action enum + non-empty ≤200 array validation; sync-shaped
  response ({action, results[]}) like /api/review.
- **queue.js**: checkbox per item + 全选;batch bar appears on selection
  (已选 N · ✓批量批准 · ✗批量拒绝 · 清空);reject arms into danger-solid with
  "确认拒绝 N 篇?sweep 后归档,找回是手工活" (5s disarm);result note with the
  first 3 per-page failures, then ui:refresh-header + ui:remount (1.5s).
- Tests: batch approve, mixed batch (409-lost + traversal + missing all isolated),
  validation + security. Playwright: 5 candidates → select 2 → bar → armed copy →
  direct approve → queue 5→3, zero JS errors (demo KB: 2 verified pages approved).

## M7 final-review-fix round (2026-08-03, 46 UI tests green): final review — 1 P2 confirmed, P3 batch, 1 misjudgment

- **① H4/H5 跟踪漏洞(确认,最重要)**:块 H 的 H4(local 内容写回 inbox 重新采集)
  / H5(Jira/Confluence 只读引导)从未交付也无裁决记录,而交付记录写着"全部交付"。
  处理 = 轻形态落地 + 需求文档留痕:raw 页面按来源显示修改路径提示(local →
  "同名文件重新上传 inbox 即重新采集"(内容哈希衔接,能力本已存在,缺的是引导);
  非 local → "请在源系统修改后重新拉取")。需求文档补交付记录。
- **P2 编辑无乐观锁(确认)**:评审 flip 有 409 而编辑没有——编辑器打开期间被
  agent 治理轮/另一次保存改动会静默覆盖。修:/api/page 带内容 sha256;编辑保存
  带 base_hash,服务端队列内比对不一致 → 409;前端冲突卡(放弃查看最新 /
  以我为准强制覆盖——强制 = 取新 hash 重放一次,快照仍兜底)。
- **P3 批次(全部确认)**:① 保存提示与编辑器首行补"重新批准前将从检索结果中
  暂时消失"(裁决⑨的隐性副作用);② review_note 保留前值(`; prev: <旧备注>`,
  agent 治理备注不再被覆盖丢失);③ J7 历史改 tab 激活懒加载(ctxTabs 支持
  lazy 值,不再每次翻页 spawn git log);④ 图谱工具栏加"边可能滞后"说明(边表
  冻结语义 vs dangling 实时扫描的口径差异,扫描③);⑤ 新测试补"先断言状态码"
  纪律(M7a 确立的模式在新文件回潮)。
- **误判 1 条**:报告称 merge-topic 确认"仍未补"——实际 M7c 修复轮已交付,形态是
  两次点击 armed 确认(govern.js:195-209,注释在案),不是模态;纪律与 raw 删除同级。
- **index.md 可编辑性(审回:by-design,不改)**:normalizeWikiRel 把 index.md 排除
  在一切写路径外是治理写门禁的设计;且 index.md 每次治理运行都被 rebuildIndex
  重新生成,人工微调会被下一次重建抹掉——"可编辑 index.md"需要的是手工段落/模板
  设计,不是放开门禁。已在需求文档留痕。
- **backlog 重排(采纳)**:C5 批量评审提前(编辑即降级让队列成为高频入口;
  设计时批量批准/批量拒绝分开讨论)→ K 评测(LLM backend registry)→ J9 → B5。
- 真实环境验收(docs/real-env-test.md)再次确认为最大非代码欠账,排在 backlog 前。
- Playwright 验证:H4 提示 ✓ 历史懒加载(未激活零请求)✓ 409 冲突卡 + 强制覆盖 ✓
  检索消失提示 ✓ 图谱滞后说明 ✓ 零 JS 错误(409 是预期响应)。

**四轮外部评审全部闭环(误判共 3 条:M7a 两条、终审一条)。M7 系列可验收。**

## M7d (2026-08-03, 45 UI tests green + 2 real-agent e2e): P2-2 hardening + wiki edit + page history

User rulings ⑧⑨⑩ before start (requirements.zh-CN.md 裁决记录): P2-2 = A 主 C 兜底
B 顺手;H2 = save demotes to candidate (any status editable, candidate edit = content
only, originals on git/G6 snapshots);H3 = 甲 (provenance read-only, drift → agent rounds).

- **P2-2 (8-round spike → docs/webui/spike-p2-2.zh-CN.md)**: the spike DISPROVED the
  original plan — path-scoped rules are dead under skip-permissions (R1/R2/S4),
  settings/flag allow rules never auto-approve Write in headless (R2/R3), and
  skip-permissions + deny [Write] is routed around via Bash (T1). The winning
  posture is **`--permission-mode acceptEdits` + generated allow-list**
  (`<kb>/.kb/ui/agent-settings.json`): cwd boundary built in (in-KB writes
  auto-accept, outside auto-deny, nothing hangs), `Bash(node <repo>/**)` for
  governance scripts (`/**` glob, NOT `:*` — R8: the prefix form breaks on args;
  S18: backslash invocations don't match — the prompt prescribes forward slashes),
  read-only git prefixes, `Read(<repo>/**)` keeps SKILL.md reachable. **Ruling ④
  revised** (skip-permissions → acceptEdits) — the only way to implement the
  user-approved A direction. C layer: post-run `git status --porcelain` diff flags
  newly-dirty paths outside {wiki/, log.md, .kb/} in the job log. B layer: prompt
  states the confinement. Residuals honestly recorded (spike doc §残余).
- **e2e ×2 (demo KB)**: run 1 (old `:*` rule) — scripts denied, agent adapted by
  hand-writing a contract-conformant candidate; run 2 (`/**` rule) — `govern.mjs
  plan --kb .` executed with args, agent verified prior work instead of duplicating;
  C layer quiet (no out-of-bounds changes).
- **H wiki edit (contract §1 whitelist ⑤ + matrix rows)**: ui/lib/edit.mjs —
  snapshot first (ruling ⑨c), body replaced wholesale, frontmatter surgery
  byte-preserving (status→candidate unless already, review_note, updated_at;
  locateFrontmatter exported from statusflip), `portal | candidate:manual` log.md
  entry. **Governance-side amendment**: sweep backfill + assertNoUnloggedFlip now
  treat `portal | candidate:*` exactly like `govern | candidate:*` (shared
  isPendingCandidateAction — the M4/M6 caliber lesson applied before it could
  bite: an unamended sweep would never backfill review flips after a portal edit).
  Guards: index.md not editable, frontmatter-paste rejected (provenance is
  governance-owned), 512KB body limit (CJK pages). /api/edit is sync-shaped over
  the queue (waitFor, like /api/review). browse reader gains 编辑 button →
  editor (read-only archive card + mono textarea + demote notice).
- **J7 page history**: /api/history — git `log --follow` (\x1f/\x1e framed),
  non-git → G6 snapshot listing + "建议 git init" hint (version-management
  constraint). Fourth ctx tab 历史 in browse.
- Playwright: editor flow (open → prefill → save → demote note → candidate
  badges) ✓ history tab ✓ zero JS errors. Demo KB: retry-resilience.md now a
  manually-edited candidate (queue 4).

**M7d 交付完成。下一:backlog(K 评测 / J9 闭环 / C5 批量 / B5 查询历史)+
并行欠账真实环境验收。**

## A7 (2026-08-02, 36 UI tests green): relationship graph + backlinks over shared edges

Scope: A7 关系图谱(user-ruled option B:wikilink 力导向图,≤2k nodes client-side
layout,visual unity with the [[引用签]] signature)+ the reviewer's folded-in item —
backlinks stop full-scanning the wiki and reuse retrieval outlinks.

- **ui/lib/graph.mjs — two edge sources, one reading caliber**: ① approved pages'
  edges come straight from the retrieval index (`docs.outlinks` after the same
  `ensureFresh` the search read path runs — zero extra scan); ② pages retrieval
  never indexes (candidates + wiki/index.md) are scanned UI-side with retrieval's
  own fence-aware `extractWikilinks`. Target resolution replicates store.mjs
  `resolveLinks` (not exported; calibers must match — the M4/M6 lesson).
  Unresolved [[targets]] are dropped; dangling links stay plan()'s domain.
- **backlinks() moved to the shared edge list** (browse.mjs's per-request full
  scan + its private WIKILINK_RE/stripCode deleted). Return shape unchanged;
  the M7a fence test passes untouched. Behavior delta (improvement): index.md's
  links now count as backlinks. Inherited retrieval caveat, documented: an
  approved page's outlinks freeze until the page itself changes — a link to a
  page created later appears after the source is re-indexed (or rebuild-index).
- **/api/graph** read endpoint (global loopback-Host gate applies); nodes carry
  path/title/type/status/isIndex for client-side coloring.
- **views/graph.js — hand-rolled force layout, zero new vendor deps**: uniform-grid
  repulsion (cell = cutoff) keeps ticks ~O(n) at the ≤2k-node cap; golden-angle
  spiral init + 180 synchronous pre-warm ticks so first paint is organized;
  alpha-decay reheats on drag. Canvas with DPR scaling, pan/zoom-to-cursor,
  node drag, hover = 1-hop neighborhood lit / rest ghosted, click navigates,
  dblclick re-fits. Tooltip is the signature chip (`[[ title ]] · type · status ·
  N 连接`); topics filled celadon, sources hollow, candidates dashed amber,
  index double-ring — the status-chip semantics the rest of the app uses.
  Toolbar: native-datalist page focus, candidate/isolated toggles, re-layout,
  node/edge/candidate stats, legend. >2k nodes → guard overlay with explicit
  "仍然渲染". SSE kb-change reloads (camera preserved), theme flip repaints
  (canvas can't follow CSS vars), MutationObserver cleanup.
- browse ctx 反链 tab gains "在图谱中查看 →" (`#/graph?focus=<rel>`); nav + hotkey
  `g r` + palette entry wired.
- Self-caught during Playwright verification: ① edges invisible at rest —
  `--line` is a hairline by design, edges now draw in `--ink-dim`; ② toolbar
  input crushed full-width — Pico's `input:not(...)` out-specifies a bare class,
  selector scoped to `.graph-bar`; ③ click-on-node never navigated — any press
  on a node armed drag mode and pointerup required "no drag", now click =
  press/release within 6px regardless of where it began.
- Playwright (demo KB, 17 nodes/20 edges): light+dark render ✓ tooltip chip ✓
  neighborhood dimming ✓ click → page ✓ focus deep-link ✓ zero JS errors.

**下一:M7d wiki 编辑(H2/H3 契约规则未议;进 M7d 前先落 P2-2 加固:
allowedTools/permissions.deny 限定 agent 写路径)。**

## M7c review-fix round (2026-08-02, 32 tests green): external M7c review — 2 P2 confirmed, zero misjudgments (third round)

- **P2-1 (D5 引导链断裂)**: dashboard stale CTA 文案还停在"请在 Claude 会话中发起
  (M7c 上线后可在这里发起)"——M7c 交付后引导终点就是错的。修:CTA 链接 #/govern;
  顶栏 stale 横幅可点(hover underline);过时括注删除。D5 定义("提示引导发起治理")
  至此闭环。
- **P2-2 (skip-permissions 残余暴露面)**: 记录在案并立项——双保险(candidate 评审 +
  作业日志)只覆盖 wiki 内写;agent 文件工具不受 cwd 限制,prompt 注入(raw 内容天然
  不可信)可写 KB 外且不留 wiki 痕迹。加固方向按成本排序写入 ADR-0006:
  --allowedTools/permissions.deny 限定写路径(可与 skip-permissions 叠加)> 提示词约束
  (弱)> 跑后 git status 比对(限 git KB)。排期:M7d 前。
- **P3 批次**: ① 作业取消全管道(queued 跳过 / running 调 kill,终态 cancelled;
  作业中心取消按钮;waitJob 识别 cancelled;测试覆盖排队取消+运行杀死后队列继续+
  终态 409)——长 agent 运行不再能堵死串行队列;② transcript 前端 64KB 界(照抄服务端);
  ③ /api/govern-context existsSync 回退(skillPath null → 回退 "Use the kb-govern skill");
  ④ merge-topic 二次点击确认(与 raw 删除同级的不可逆操作,纪律对齐);
  ⑤ 运行完成 → "去评审队列"链接 + 自动刷新 plan 闭环;⑥ tool_use 显示关键参数
  ([Write: wiki/topics/x.md] 比 [tool: Write] 更能讲清 agent 在干什么,演示场景加分);
  ⑦ 计划清单刷新时间戳;⑧ 提示词安抚句("通常不用改");⑨ ADR-0006 补两笔:
  stdin prompt + SKILL.md 文件指向(注册无关,I3 实际可插拔性增强的正式记录)。
- Playwright 验证:CTA 链接 ✓ 横幅跳转 ✓ SKILL.md 路径进提示词 ✓ 时间戳 ✓ 零 JS 错误。

**M7 系列 (a/b/c) 至此全部交付且全部经外部评审验收。下一:A7 图谱小里程碑。**

## M7c (2026-08-02, 31 tests green + real-agent e2e): governance console — agent executor live

Scope: I1 mechanical steps + I2/I3 executor + I4 streaming + I5 plan-as-preview.
User rulings before start: permission posture = --dangerously-skip-permissions;
A7 graph NOT folded in (separate mini-milestone next).

- **executor.mjs (I2/I3)**: `startRun(name, spec) → {events, kill}` + public
  `registerExecutor` — the pluggability requirement is one function call
  (tests register 'mock'/'mock-fail' through the same path; third-party
  framework backends plug in identically). Claude impl: spawn claude.cmd
  (no shell), stream-json JSONL parsed progressively (init/assistant/result;
  tool_use shown as [tool: name]); verdict from the RESULT event
  (is_error + subtype + blocked-write text pattern), never the exit code.
- **The spike missed a killer, e2e caught it**: prompts must go via STDIN —
  claude.cmd is a %* batch shim and cmd.exe treats a literal newline in the
  command line as a command terminator. Multi-line prompt in argv → zero
  output, no result event, silent hang/exit-0. Single-line works — which is
  exactly what the S7 spike tested. Repro isolated with a bash-quoting-free
  .mjs (two earlier "repros" were garbage: bash ate the backslashes, a
  reminder to never probe Windows paths through bash -e strings).
  spike-s7.zh-CN.md backfill amended.
- **I4**: SSE gains a 'run' channel (runBridge EventEmitter) — job events stay
  coarse (queued/running/done), executor chunks stream granularly with jobId
  routing; frontend ui:run appends to a live transcript (auto-scroll).
- **I5**: GET /api/plan returns the full six lists (titles+reasons) — health()
  serves counts, this serves the confirm page; CTA disabled when plan empty,
  "将要发生" summary sentence before launch.
- **I1**: /api/govern whitelist sweep|rebuild-index|merge-topic (slug-validated),
  spawned govern.mjs via the serial queue. approve/reject stay in the queue view.
- **e2e with the REAL agent on the demo KB**: fresh raw uploaded → plan preview
  showed it → run launched from the UI → transcript streamed live → agent
  produced a contract-conformant source page + a topic draft WITH a review_note
  flagging merge-vs-standalone + log.md entries + index update, all candidates.
  Statusbar went 14 → 16 pages, queue pill 1 → 3. Agent reported "kb-govern
  skill isn't registered in this environment" and improvised from repo
  conventions (correctly!) — so the default prompt now points at the skill
  FILE (/api/govern-context → governance/skills/govern/SKILL.md), making runs
  registration-independent and more executor-agnostic.
- 31 UI tests (6 new M7c: mock-executor chain, SSE run streaming, plan lists,
  mechanical validation, security); Playwright: zero JS errors.

## M7b review-fix round (2026-08-02, 25 tests green): external M7b review — 4 P2 all confirmed, zero misjudgments

Second consecutive zero-misjudgment external review (M7b-review.zh-CN.md). All 4 P2
fixed + verified, P3 batch done:

- **P2-1 (journey bug)**: raw delete/move success used to remount on the stale hash →
  guaranteed 404 page. rawOpsModal gains a `navigate` (function-aware) landing: delete
  → `#/browse`, move → `#/browse?raw=<new path>` (evaluated at confirm time, not modal
  creation — first attempt froze the input's initial value). Playwright: real delete
  via UI lands on #/browse, no error page.
- **P2-2 (read-side security posture)**: writes had token+Origin+Host but reads/SSE/
  static had NO Host check — DNS rebinding is same-origin to the browser and could
  read the whole KB (CORS only blocks cross-origin RESPONSE reads). Fix: auth.checkHost
  applied to every request at the server entry; checkWrite keeps its own token+Origin
  layers. Test: bad Host → 403 on /api/health, /api/jobs, /api/events, /, /style.css
  (node:http again — fetch ignores custom Host).
- **P2-3**: jobs.jsonl was append-only forever. Compaction at load past 2MB: keep
  final records of the latest KEEP jobs only (matches the in-memory slice exactly) +
  trim surviving logs to 4KB tails, atomic tmp+rename. First fix attempt kept
  last-per-id for ALL jobs — still unbounded (each done-line carries ≤64KB log);
  the self-written test caught it (2.2MB → still 2.2MB). Bounded now: ~200 × 5KB.
- **P2-4**: settled Map leaked one Promise per job for the portal's lifetime. Deleted
  at job terminal; waitFor tolerates a missing entry (awaits undefined → the job
  record itself is the source of truth).
- **P3 batch**: J6 relative time (今天/昨天/N 天前) + >7d amber stale signal; I6 job
  duration chip; header job indicator (running count celadon / recent-failure red dot,
  seeded from /api/jobs at startup, click → #/acquire, clears) — I6's first step from
  acquire-view panel to app-wide hub, exactly where M7c governance jobs will surface;
  waitJob timeout wording ("作业仍在队列中执行" — the job DOES run later, retrying
  would double-execute); upload aggregate note (per-file notes overwrote each other);
  inbox delete title honest (物理删除不可恢复); dual-portal warning in startup banner
  (two processes = two in-memory queues = serial guarantee gone).
- Frontend gotcha worth remembering: a 52ms local pull makes queued→done arrive in
  one burst — the running indicator is correct-but-invisible for fast jobs; verify
  indicator logic via the failure-seed path instead.

**M7b status: accepted by reviewer pending these fixes — now complete, no blockers. Next: M7c.**

## M7b (2026-08-02, 23+36+39 tests green): acquisition console — the portal's first real write surface

Full scope delivered: jobs.mjs (S10) + E upload + F source pull + G raw delete/move
+ J3 fs-watch + J4 inbox + J5 auth check + J6 freshness (J3-5 formally moved here by
M7a-review ruling). One sanctioned acquisition increment: `recordRun` appends
`.kb/acquire_runs.jsonl` (contract §1 pre-defined; the only record of all-skipped
incremental pulls — CLI-driven pulls covered too, a UI-side record would miss them).

- **jobs.mjs**: per-KB serial chain (Map kb→promise tail; a failed job never poisons
  the chain — unit-tested order first/second(fail)/third). Every job persisted as JSONL
  to `.kb/ui/jobs.jsonl` (append full record per transition, readers take last line per
  id); on load, queued/running leftovers from a dead process tombstoned to failed.
  `waitFor(job)` lets endpoints keep sync request/response while writes stay serialized
  (review flip now goes through the queue too — ADR discipline uniform). spawnJob
  helper: bounded log tail (64KB), exit≠0 → throw.
- **E upload**: POST /api/upload raw bytes + X-Filename (encodeURIComponent — CJK names
  survive latin1 headers), 32MB cap separate from the 64KB JSON reader; the inbox file
  is written INSIDE the queued job (inbox writes serialized with everything else), then
  spawn acquire local — one job, two steps.
- **F pull**: POST /api/pull {connector, jql?, cql?, max?} → spawn acquire CLI (max
  clamped 1-500); J5 /api/authcheck spawns --check OFF-queue (read-only probe).
- **G raw ops**: delete/move as queued jobs; move = new identity (target-exists guard,
  both paths gated by normalizeRawRel — traversal to wiki/ refused, tested). G6 snapshot
  FIRST: git repo → pathspec-scoped commit (`git commit -- <path>` so unrelated worktree
  changes are NOT swept in; `-c user.name=kb-portal` fixed machine author — greppable,
  and independent of the machine's git config); no git → copy to `.kb/ui/snapshots/
  <ts>-<jobid>/`. G5 impact preview reuses /api/rawrefs (frontend modal lists tracing
  wiki pages before confirm).
- **J3**: lib/watch.mjs — lazy per-KB fs.watch recursive (Node 20 win32 OK), refcounted
  by SSE clients; two storm guards: .kb/ excluded (portal's own derived writes must not
  retrigger it) + 400ms debounce (one acquire = one refresh). SSE /api/events streams
  change + job events; app.js EventSource dispatches ui:kb-change/ui:job; 30s poll kept
  as SSE-down fallback.
- **Frontend**: views/acquire.js (dropzone, three pull cards, freshness rows, inbox
  list, job center with status chips + expandable log tails — live via SSE); raw ctx
  panel gains 移动/删除 with impact-preview modal; 6 new icons; routes g a / #/acquire.
  Playwright-verified on demo KB: real pull through the UI (job done chip + full acquire
  JSON), freshness updated live, delete modal lists 2 tracing wiki pages, zero JS errors.
- Frontend gotchas added: Pico styles bare `<button>` with a dark background — outline
  variants must reset `background: none` explicitly; Windows full_page screenshots
  duplicate the fixed header mid-image (capture artifact, not a layout bug).

**M7a work committed (50aaab0 test layer + e75c198 M7a) before M7b started.**

## M7a slice 4 (2026-08-02, 14 tests green): quality-review fix batch — M7a COMPLETE

External quality review (M7a-review.zh-CN.md, verified **zero misjudgments** — every
claim confirmed against code): 1 scope ruling, 2 requirement deviations, 1 test-env
issue, 5 P2 consistency leaks, 6 P3 polish items. All handled:

- **Scope ruling (user-decided)**: J3/J4/J5 formally moved M7a → M7b (fs-watch belongs
  with jobs.mjs design); J3 delivered in transitional form NOW (write-refresh via
  ui:refresh-header event + 30s visibility-aware health polling + manual refresh button)
- **A5 delivered full-strength (user-decided)**: side-by-side wiki⇄raw split view
  (compare button on source pages) + raw → wiki reverse references (/api/rawrefs,
  frontmatter scan shared with M7b's G5 impact preview — one investment, two payoffs)
- **Node pinned to 20.x (user-decided)**: better-sqlite3 (11.10.0) is ABI-locked —
  reviewer's node 24 run failed ERR_DLOPEN_FAILED with the error masked by a body-first
  assertion. Fixed: test asserts status before body (with "native module healthy?"
  message), engines ^20 ×3, installation.md(+zh-CN) pinning with the failure mode named
- **P2 ×5**: header counts refresh after review (CustomEvent); queue hotkeys unbind
  before bind (hotkeys-js stacks duplicates); g k bound (ghost shortcut); queue view
  uses /api/queue (endpoint no longer dead surface); alpine script tag commented out
  (file kept as P2-1 pressure valve — zero x-data usage)
- **P3 ×8**: 409 conflict card gains a refresh button; score tooltip (BM25 heuristic
  explained); palette mousemove swaps class only (no 12-row rebuild); slugify dedupes
  heading ids per document; fold memory immune to filter-force-open; index.md in the
  tree (A4 — it was unreachable from tree/palette); dashboard timeline targets
  clickable (demo journey); D1 source-system distribution line (was page-type)
- A4 addendum: /api/tree includes index.md flagged isIndex; health counts exclude it

**M7a is now feature-complete per the frozen requirements (+ ruling).** Next: M7b
(jobs.mjs + S10 serial write queue + upload/raw management) — or the long-pending
real-environment acceptance (docs/real-env-test.md), still unscheduled.

## M7a slice 3 (2026-08-02, 13 tests green): UI audit round 2 — all findings fixed

Full-site UI audit (docs/webui/ui-audit-round2.zh-CN.md, 2 P0 + 8 P1 + 10 P2), all fixed:

- **P0-2 review hotkeys leaked globally** — pressing 'a' on ANY page could silently
  approve a candidate (detached button, invisible feedback). Fix: hotkeys-js scopes
  ('queue' scope dies on route change; app.js resets 'all' per mount). Behavior-verified:
  zero POST after leaving queue. Also j/k navigation added in queue
- **P0-1 tree filter lost focus per keystroke** — renderTree rebuilt the input itself;
  filter is now outside the re-render scope (verified: activeElement survives typing);
  Esc clears
- **Tree/layout overhaul** — drag-resizable tree (180–400px, persisted); segmented
  [wiki|raw] control (raw duplicates gone); true icon rail in collapsed mode
  (expand/wiki/raw entries, instant tooltips — collapsed was a navigation dead end);
  collapsed grid drops the 366px ghost column (3-col template, reader widens to 800px);
  group headers with icons+count pills, indent guides, celadon current-item bar, 30px rows
- P1: '?' shortcuts overlay (statusbar link + palette entry); snippet markdown tokens
  stripped; score<0.001 hidden; KB selector dedupes by resolved path (kbs.json name wins)
- P2: TOC javascript:void → preventDefault; dashboard stat-top icon row + timeline
  day grouping; route loading bar; /favicon.ico → 204; '/' focuses search input on the
  search view; chips source from frontmatter (server tree gains `source`); preview
  loading state; raw items meta tooltip; dark --ink-dim contrast bump

Gotcha recorded: Playwright probes (getBoundingClientRect/computed style) beat
eyeballing downscaled screenshots — two "missing icons" were actually rendering fine.

## M7a slice 2 delivered (2026-08-02, ui/ 12 tests green): full visual/interaction redesign


User feedback on slice 1: "太丑、交互差". Process: two research rounds
(docs/webui/research-design.zh-CN.md — vendorable CSS/JS libs with live stars+sizes;
research-design-skills.zh-CN.md — AI-design skill resources) → design plan approved
(docs/webui/design-plan.zh-CN.md, "Archival Editorial" direction) → implemented via the
official frontend-design skill's two-phase flow.

- **Theme**: celadon signature color (#0d7a6f) + ink/paper neutrals (NOT cream+terracotta
  or purple-gradient — the named AI-slop defaults); Newsreader serif display + system
  body (CJK) + IBM Plex Mono metadata (all vendored woff2 subsets); signature element =
  `[[ reference chips ]]` for wikilinks site-wide (dashed dead links)
- **Vendored** (still zero npm, zero build): Pico CSS 2.1.1 (classless base), Alpine.js,
  hotkeys-js, tippy.js + **Popper UMD** (the jsDelivr "tippy-bundle" is NOT actually
  bundled — it expects window.Popper; missing this = "tippy is not defined"),
  34 lucide SVGs inlined into lib/icons.js
- **New UX**: slim 40px header + 28px mono statusbar; Ctrl+K command palette (fuzzy
  pages+actions, full keyboard); collapsible tree with filter + fold memory; centered
  720px reader with archive card; tabbed context panel (info/backlinks/**TOC scroll-spy**);
  wikilink hover previews; heading-anchor copy; live debounced search with filter chips
  + term highlighting + skeletons; sticky review bar with a/r/[/] hotkeys + explicit 409
  conflict card; dashboard dossier strip + /api/log governance timeline (D2); empty
  states as action invitations
- **Bugs found by self-screenshotting** (Playwright + system Edge, cdn.playwright.dev is
  network-blocked — use `channel='msedge'`, and Windows python resolves /tmp to D:\tmp):
  ① icons.js generator folded SVG newlines to nothing, fusing attributes into invalid
  HTML — DOMPurify stripped everything (empty CTA, missing icons); ② Pico styles bare
  `<nav>` as flex — the tree's two details became overlapping flex items (fix: display:block);
  ③ grid had 3 columns for 4 items (rail/tree/reader/ctx); ④ flex ellipsis needs
  min-width:0 or the title shrinks to zero next to a badge; ⑤ .woff2 missing from the
  static MIME map; ⑥ hash-only navigation doesn't re-run init code (theme test artifact)
- Added /api/log (log.md prefix parse, newest first) + test; 12 tests all green
- Addendum: **raw-layer browse** (C9 scenario had been folded into M7b by mistake) —
  /api/rawlist (identity quintuple per doc) + tree "raw" group with source labels;
  read-only, no S10 queue needed (delete/move still M7b); 13 tests green

## M7a slice 1 delivered (2026-08-02, ui/ 11 tests green)

First vertical slice of the UI portal (ADR-0006, option 1 no-build SPA):

- `ui/serve.mjs` — node:http 127.0.0.1:8322 on demand; read-hot paths import service
  libs in-process (S2); the only write is POST /api/review → governance statusflip
- `ui/lib/` — paths (shared norm, wiki/raw read gates), auth (**per-startup token +
  Origin/Host checks on writes** — localhost POST is not CORS-protected), kb registry
  (ui/kbs.json, gitignored), search (in-process ensureFresh+search; `routed` from
  search()'s return — B4 needs no CLI change; candidates_file read immediately,
  never referenced later — KEEP=20 churn), review (statusflip re-export), browse
  (tree/backlinks with fence-aware stripCode/health via governance plan — D3/D5)
- `ui/public/` — no-build ES modules: hash-router app.js + four views (dashboard /
  browse / search / queue) + lib (api.js only request exit, render.js **only
  innerHTML exit, DOMPurify default** — pinned by a grep test), md.js (marked +
  wikilink tokenizer, dead-link styling), diff.js (LCS); vendored marked 15.0.12 +
  DOMPurify 3.4.12; **zero npm dependencies**
- Contract §1 amendment (increment-compatible): UI portal column in the write matrix,
  `.kb/ui/` + `acquire_runs.jsonl` entries, write whitelist; CONTEXT "no Web UI" →
  "no web platform"; ADR-0006
- S7 spike (docs/webui/spike-s7.zh-CN.md): stream-json is genuinely progressive;
  `spawn('claude.cmd')` direct (no shell); headless default blocks tool writes with
  **exit 0** (exit code is not an error signal — parse result events);
  permission posture deferred to M7c by user decision
- Gotchas pinned by tests: fetch/undici **ignores a user-set Host header** (the
  DNS-rebinding test must use node:http); auth Host regex must be port-agnostic
  (ephemeral port 0 in tests); frontend syntax verified via `node --input-type=module
  --check` (browser modules are outside node:test's reach)

Deferred to later slices: J3 fs-watch auto-refresh, J4 inbox management, J5 auth
check, M7b upload/raw-management (needs jobs.mjs + S10 queue), M7c executor.

Run tests: `cd ui && node --test test/` (11).


## Cross-service test layer (2026-08-01): 39 tests green, eval Hit@5 = 1.000

New top-level `tests/` closes the gap between the mocked unit suites and the
real-environment acceptance checklist — everything except the live Jira/Confluence
connections, driven through the real CLIs on a scratch KB:

- `tests/fixtures/inbox/` — fictional payment-system corpus (EN×5, CJK×2, mixed,
  txt, unsupported docx, empty, deep/structured long-doc), deterministic mtimes
  (date-filter tests depend on them); `tests/fixtures/summaries/` — pre-written
  apply-source summaries (CJK summaries carry original-form anchors, the only way
  CJK terms can be retrievable — wiki is English-only per governance.md §1)
- `tests/e2e/pipeline.test.mjs` (20) — acquire (create/skip/update/orphan/prune,
  frontmatter quintuple, no wiki writes) → govern (plan drain, stale, anomaly via
  content-change-with-reset-mtime, contract-violation errors, topic candidate
  protection, CLI approve/reject, real viewer over HTTP incl. 409 + unlogged-flip
  guard + idempotent sweep backfill, merge-topic backlink rewrite, orphan archive,
  dangling links, index format, log.md §5 audit) → retrieval gates (candidate/
  archived invisible to search and read, ARCHIVE case bypass, anchor read, fence
  fidelity)
- `tests/eval/retrieval-eval.test.mjs` + `queries.json` (19) — golden query set
  (stemming, phrase, CJK LIKE/trigram routing, type:/tag:/date filters on
  source-system time, graph expansion via:link, negative query) scored Hit@1 =
  0.706, **Hit@5 = 1.000**, MRR = 0.819; threshold Hit@5 ≥ 0.85 is pinned as a
  regression gate; report regenerated at `docs/test-reports/retrieval-eval-latest.md`
- Gotcha recorded: `node --test <dir>` only picks up `*.test.mjs` — the eval file
  had to be named `retrieval-eval.test.mjs` to be discovered
- Human-in-the-loop layer: `docs/manual-test-guide.zh-CN.md` (skill conversation
  flow, summary/synthesis quality scoring, review dual-channel, retrieval Q&A,
  failure drills)

Run: `node --test tests/` from the repo root.

## Current status: M0-M6 ✅, 125 tests all green (acquisition 36 / governance 52 / retrieval 37)

| Milestone | Deliverables | Tests |
|---|---|---|
| M0 Contract | schema/contract.md (v1 frozen), governance.md, ADR×4, CONTEXT.md | — |
| M1 Acquisition | acquisition/{scripts,skills/acquire}: framework (kb/frontmatter/rawdoc/log) + local connector (inbox→raw/local, incremental skip, reconcile orphaned + --prune) | 3 |
| M2 Governance v1 | governance/{scripts,skills/govern}: plan (four lists: pending/anomalies/orphaned_pages/errors), apply-source (summary via stdin, mechanical frontmatter), rebuild-index | 8 |
| M3 Retrieval | retrieval/{scripts,skills/search}: dual FTS5 tables (fts_latin=porter+unicode61 / fts_cjk=trigram), per-term routing (CJK<3 chars→LIKE fallback), structured query (type/source/tag/after/before, source-system-time preferred), ≤2 snippets per page, candidate space persisted to disk (capped at 20, cleanup excludes current run), wikilink graph expansion (top-10, supports #anchor), read #anchor (includes subsections, approved whitelist gate, path/archive checks share norm() case normalization), lazy incremental (skips table dual-key reconcile), fence recognition ~~~ / 4+ backticks / inline code excluded | 34+1 |
| M4 Governance v2 | topic pages (apply-topic: slug=identity whitelist, sources union-merge, fail-closed provenance, --candidate), candidate state machine (plan review_queue, approve/reject/archive, sweep = log backfill + rejected→archive, idempotent, archive name-collision -N suffix), thin viewer (governance/viewer/: node:http 127.0.0.1 on-demand, no-build HTML/vanilla JS, queue/browse/page views, raw-evidence pane, approve/reject = flipStatus only, byte-preserving CRLF+BOM, 409 optimistic concurrency) | 8→31 |
| M5 Jira connector | acquisition/scripts/connectors/jira.mjs (Node rewrite of the old Python jira.py): Server/DC PAT Bearer auth (env var named by kb.json pat_env, PAT never on disk/log/errors), JQL scopes from kb.json (CLI --jql override, --max cap, --check = myself), startAt/maxResults pagination, ADF→text fallback, issue→normalized markdown (English scaffold, content keeps source language), raw/jira/<KEY>.md via the shared upsertRawDoc framework (incremental skip by content_hash), non-compliant keys skipped with error (contract §2 whitelist) | 4→15 |
| M6 Confluence connector | acquisition/scripts/connectors/confluence.mjs: same PAT/framework pattern as Jira; scopes = kb.json spaces (→ `space = "KEY" AND type = page`) or explicit cql (CLI --cql override); CQL search start/limit pagination with totalSize→truncated[]; storage XHTML→markdown = hand-rolled minimal converter (zero new deps): headings/lists/tables/code+panel macros/links/images/entities/CDATA preserved, unknown macros → visible [macro: name] placeholder (never silently dropped), original XHTML discarded per contract §2; version.number + full-precision timestamp in the hashed body (no same-day blind spot); comments not pulled (v1) | 19→34 |

Run tests: per service `cd <service>/scripts && node --test test/` (governance also runs
`../viewer/test/`; retrieval requires npm install first — better-sqlite3 already installed).

## M6 review-fix round 2 (2026-08-01, 125 tests all green: acquisition 36 / governance 52 / retrieval 37)

Second-round review of the round-1 fixes: 1 regression + 3 record-only items. The
regression is confirmed and fixed; the record-only items are agreed (no action).

- **Regression (low-medium): the br sentinel inverted the bug instead of fixing it** —
  round 1's HARD_BREAK is restored to '\n' only AFTER the global cleanup, but blockquote,
  panel macros, and list items compute line structure AT RENDER TIME via split('\n'), and
  headings are single-line contexts. None of the four consumers had been updated, so the
  post-br line escaped its structure: `> first\nsecond` (out of the quote), `- first\nsecond`
  (indent lost, list broken), `## one\ntwo` (heading split into heading + paragraph).
  Exactly the N1/N3 lesson again: the round-1 fix audited only the COLLAPSING consumers
  (renderInline, table cells) and missed the SPLITTING consumers. Fix: one shared
  splitLines() helper that splits on both '\n' and the sentinel, used by blockquote /
  panel macro / list continuation; headings flatten the sentinel to a space. Four
  regression tests pin one case each
- Recorded without change (agreed): blockquote multi-paragraph emits consecutive `>` blank
  lines (pre-existing, render-equivalent); a standalone <br> between paragraphs may leave a
  longer newline run (markdown-equivalent); FENCE_RE mismatch direction on pathological
  inline backtick spans is fail-safe (it only skips cleanup, never corrupts content)

## M6 review-fix round (2026-08-01, 124 tests all green: acquisition 35 / governance 52 / retrieval 37)

External review of M6: 5 converter findings (low-medium/low) + 3 contract/doc findings.
All 8 confirmed (zero misjudgments); 6 fixed, 2 recorded as by-design.

- **Finding 1 (low-medium): global whitespace cleanup rewrote fenced code** —
  storageToMarkdown's `[ \t]+\n` / `\n{3,}` replacements ran over the whole document,
  silently collapsing blank lines and stripping trailing spaces inside code-macro CDATA —
  the highest-evidence content in the evidence layer. This is the M4 reading-convention
  drift in a new guise: the retrieval chunker is fence-aware, the converter was not.
  Fix: cleanup is now fence-aware (fenced spans are located first, tidy() applies only
  outside them). Pinned: CDATA with 3 blank lines + trailing spaces survives verbatim
- **Finding 2 (low-medium): fixed triple-backtick fence bursts on content containing ```** —
  M3's fence rules recognize 4+ backticks, but the converter always emitted 3 (asymmetric
  convention, same root cause class). Fix: fence length = longest backtick run in the
  content + 1 (min 3), for code macros, pre blocks, and inline code. Pinned
- **Finding 3 (low): nested table rendered as pipe-escaped garbage** — collect() correctly
  stops at the first <tr> (inner rows never leak into the outer table — reviewer verified),
  but the inner table rendered inline inside the cell as `\| ... \|` noise. Fix: in inline
  contexts (cells/headings) tables degrade to a visible `[table]` placeholder — same
  philosophy as unknown macros. Pinned
- **Finding 4 (low): `<br>` inside `<p>` was dead code** — br emitted '\n', then p's
  renderInline collapsed it to a space. Fix: br renders a sentinel char; the inline
  collapse eats only meaningless (pretty-print) newlines; the sentinel becomes a real
  newline after cleanup. Pinned
- **Finding 5 (low): no-`<th>` tables promoted the first data row to header** — reviewer
  accepted this as a declared tradeoff, but the fix was cheap: such tables now get an
  EMPTY header row and the first row stays data. Pinned
- **Contract §6 example missing the `cql` key (doc drift)** — the connector reads
  connectors.confluence.cql and CONTEXT.md already specified "space key + optional CQL",
  but the contract example showed only {base_url, pat_env, spaces}. Fix: §6 example now
  includes `cql`, with a prose line documenting scope-key precedence (cql overrides
  spaces). CONTEXT.md checked per §7 — already consistent, no edit needed
- **Recorded by design (no code change)**: Confluence has no orphan reconcile — a CQL/space
  scope is a query, not an inventory (same as Jira's M5 record); now written into DEVLOG +
  SKILL.md. Attachment-only changes are invisible to the incremental skip (an attachment
  upload neither bumps version.number nor changes the storage XHTML; attachments render as
  placeholders anyway) — inherent boundary, recorded in SKILL.md

Carried-forward lesson, third occurrence: **when two components share a format convention,
check both sides whenever one changes** (M4: parser vs reader; M5 round 2: contract rule vs
every implementer; now: chunker fence-awareness vs converter fence-emission).

## M6 delivered (2026-08-01): Confluence connector, 34 acquisition tests all green

`connectors/confluence.mjs` follows the M5 Jira pattern line for line (resolveAuth shared by
run/check, per-scope failure isolation + auth fail-fast, no-silent-caps truncation, reject-
with-error on non-compliant ids, CLI e2e via async spawn). Zero contract amendment: the
kb.json §6 shape already defined `connectors.confluence` {base_url, pat_env, spaces}.

M6-specific decisions:

- **Scope resolution**: CLI `--cql` > kb.json `cql` (string or array) > kb.json `spaces`
  (each space key becomes `space = "KEY" AND type = page`). Empty scope list = config error
- **XHTML→markdown is minimal by declaration** (same stance as the Jira ADF fallback):
  a hand-rolled tolerant parser (zero new dependencies) + renderer covering headings,
  p/br/hr, strong/em/code/pre, ul/ol (nested), tables (first row = header, `|` escaped),
  external/relative links (relative resolved against base_url), attachments as
  `[attachment: name]`, code/info/note/warning/tip/status macros, entities + CDATA.
  Unknown macros render as `[macro: name]` — a visible placeholder instead of a silent
  drop; `toc` is navigation chrome and is dropped. Page comments are not pulled (v1)
- **No same-day blind spot**: the body header embeds `Version: <number>` AND the
  full-precision `Last modified` timestamp; Confluence bumps version.number on every edit
- **expand** = body.storage,version,space,metadata.labels,ancestors; ancestors render as a
  `- Location: SPACE > Parent > …` breadcrumb; extra = {space, version, labels, content_type}
- source_version = version.when normalized to Z; source_url = _links.webui (fallback
  viewpage.action?pageId=); page ids are numeric → contract §2-compliant by construction,
  still whitelist-checked

Tests: 14 connector tests (mirror of the Jira suite + same-day-edit regression + a
storageToMarkdown unit block: macros, entities, CDATA, ac:link/ri:page, tables, lists) +
1 CLI e2e (kb.json + env PAT through the real acquire.mjs, --check round-trip, bool-flag
trap). One fixture slip: frontmatter.mjs quotes numeric-looking source_ids
(`source_id: "123456"`) — assertion fixed to match.

## M5 review-fix round 2 (2026-08-01, 108 tests all green)

Second-round review of the M5 fixes: 2 findings, both confirmed, both fixed.

- **N1 (low): UTC normalization changed derived values without a schema bump** —
  pre-fix KBs would have kept raw-offset `src_updated` rows until each page's next edit,
  mis-sorted in the interim. Fix: SCHEMA_VERSION 3→4 (full rebuild, zero cost for a
  derived artifact), matching the user_version 2/3 precedent from M3's date-semantics
  changes; the bump history is now documented in the comment
- **N2 (wording nit): the new contract §2 rule did not hold for local** — local's body
  IS the content (content-addressed, self-versioning); mtime is not embedded and
  skipping an mtime-only change is correct. Fix: contract §2 and CONTEXT.md now scope
  the "embed the version at full precision" rule to sources whose version is metadata
  outside the content (e.g. Jira), with content-addressed sources called out as
  self-versioning

## M5 review-fix round (2026-08-01, 108 tests all green: acquisition 19 / governance 52 / retrieval 37)

External review of M5: 3 medium-low + 10 low + 2 engineering gaps. Confirmed and fixed:
3 medium-low, L1-L6, L8, gap 1. Recorded without code change: L7/L9/L10.

- **Finding 1 same-day blind spot (medium-low)**: the hashed body rendered `Updated:` at
  day granularity and upsertRawDoc skips on content_hash alone, so a same-day second edit
  left both the body and source_version stale until the next day (a fixVersions-only
  change could stay invisible indefinitely). Fix: the body header now embeds full-precision
  ISO timestamps (Jira bumps `updated` on every edit, so any edit changes the hash);
  contract §2's incremental rule reworded to match reality — hash-only skip, with the
  connector required to embed the source-system version at full precision in the hashed
  body (CONTEXT.md synced per §7). Regression: same-day edit pinned as `updated`
- **Finding 2 silent --max truncation (medium-low)**: searchAll read but never compared
  the server's `total`. Fix: summary gains `truncated: [{jql, fetched, total}]`; SKILL.md
  instructs always surfacing it (no-silent-caps lesson applied). Pinned
- **Finding 3 one bad JQL aborted the whole batch (medium-low)**: per-issue failures had
  an errors fallback but per-scope failures did not. Fix: per-scope try/catch records
  `{jql, error}` and continues; auth failures (401/403) carry `err.authFailed` and still
  fail fast (every scope would fail identically). Both behaviors pinned
- **L1 mixed-offset date filter (latent, real)**: store.mjs indexed src_updated verbatim
  and query.mjs compares lexicographically — a `+08:00` value would mis-sort against Z.
  Fix: both date columns normalized to UTC at index time; regression pins a +08:00 page
  crossing a UTC day boundary. Contract §2 example switched to Z with an explicit
  "any ISO offset is legal, retrieval normalizes" note (folds in L3)
- **L2 contract §2 wording**: "escape or hash-map" now also blesses "reject with an
  error" (the jira connector's fail-closed skip)
- **L4 check() duplicated config resolution**: shared `resolveAuth` extracted — the
  same-drift class as review rounds 2-3
- **L5 intranet TLS gap**: SKILL.md documents `NODE_EXTRA_CA_CERTS` (and warns against
  `NODE_TLS_REJECT_UNAUTHORIZED=0`)
- **L6 test gaps**: 403 mapping / truncation / per-scope failure / same-day edit / ADF
  hardBreak+mention all pinned
- **L8**: SKILL wording — `total` = unique issues matched, before per-issue write errors
- **Recorded, no change**: L7 ADF fidelity (declared minimal fallback; hardBreak/mention
  handled as a cheap win, tables stay concatenated); L9 exit code 0 with errors
  (consistent with local; SKILL mandates reporting errors — script callers must not
  judge success by exit code alone); L10 redirect:'follow' (Node 20 undici strips
  Authorization on cross-origin redirects, so no leakage; 'manual' would break
  legitimate intranet http→https redirects)
- **Gap 1 (engineering)**: the code repo now has .gitignore (node_modules first),
  git init, and an initial commit — the previous single biggest risk is closed
- **Gap 2 (M6 prep, recorded)**: reuse the mock-node:http test pattern for Confluence;
  storage XHTML→markdown is M6's main quality risk — prepare fixture corpora

## M5 delivered (2026-08-01, 103 tests all green: acquisition 15 / governance 52 / retrieval 36)

No contract amendment needed — §1 (raw/jira/<issue-key>.md), §2 (identity quintuple,
character whitelist) and §6 (kb.json connectors.jira: base_url / pat_env / jql) already
defined the shape; the connector just implements it.

Key design decisions:

- **Zero new dependencies**: Node 20 global fetch + AbortSignal.timeout(30s), redirect:
  follow; the mock-server tests exercise the real HTTP path (auth header, pagination,
  401 mapping) with zero network
- **Secrets discipline**: resolveConfig reads `process.env[pat_env]` only; auth errors say
  "check the PAT in env var <NAME>" and a test asserts the PAT value never appears in the
  error message
- **extra metadata is scalar-only** (frontmatter.mjs supports one level of nested scalars):
  labels/components/fix_versions are comma-joined, matching the old Python behavior
- **Jira "+0800" offsets normalized to strict ISO 8601** (unparseable values pass through
  unchanged, kept visible rather than invented)
- **JQL dedupe by issue key** across multiple scopes; per-issue failures (bad key, write
  error) land in `errors` without aborting the batch
- **No orphan reconcile for jira** (unlike local): a JQL is a query scope, not an
  inventory — an issue leaving the scope is not "gone". Recorded as by-design
- CLI e2e test spawns the real CLI against a mock server (async spawn — a sync spawn would
  starve the mock server's event loop)

## M4 third review-fix round (2026-07-31, 92 tests all green: acquisition 4 / governance 52 / retrieval 36)

Third external review: 1 low-medium + 2 low, all confirmed (no misjudgments), all fixed.

- **N1 guards sat on the strict parser (low-medium)**: applyTopicPage read old.status via
  parseFrontmatter (requires ": "), so a hand-mangled `status:candidate` (no space) made
  BOTH guards fall at once — a re-apply approved the page with no review. merge/archive
  already used the tolerant readStatus. Fix: applyTopicPage now reads status via
  readStatus too (one status-reading convention per service); the re-apply keeps the page
  candidate and the rewrite heals the mangled format. Regression pinned
- **N2 docs under-reported the guard scope (low)**: governance.md §3 and SKILL.md named
  only apply-topic; both now name apply-topic/merge-topic/archive (contract §4 was already
  correct)
- **N3 "both sides agree on what counts as a link" was aspirational (low)**: retrieval's
  extractWikilinks still scanned raw text, so [[links]] inside code samples became graph
  edges (via:link noise). Fixed at the source rather than softening the wording:
  extractWikilinks now strips fenced blocks and inline code first (same rules as the
  chunker and the governance stripCode — duplicated by hand across the service boundary);
  graph-expansion regression pinned

Lesson carried forward: when a guard or convention is introduced, audit every consumer of
the same input for reading-convention drift (strict parser vs tolerant reader; raw text vs
code-stripped text) — rounds N1 and N3 were both this class.

## M4 second review-fix round (2026-07-31, 90 tests all green: acquisition 4 / governance 51 / retrieval 35)

Second external review: 2 medium + 4 low, all confirmed (no misjudgments), all fixed.
The round-one M2 fix had guarded only apply-topic; this round closes the guard around
EVERY page-mutating command, so contract §4's "the audit narrative cannot be silently
truncated" now holds literally.

- **M1' backfill truncation via merge/archive (medium)**: three reproduced variants
  (unlogged viewer flip on the merge target / merge source / archive victim). Fix:
  `assertNoUnloggedFlip` is now a shared precondition of apply-topic, merge-topic AND
  archive — all three refuse with "unlogged review flip pending on this page; run sweep
  first". Contract §4 wording updated to name all three commands (the strong promise
  stays; no softening needed)
- **M2' merge had no status guard (low-medium)**: a candidate page could be merged
  (and thereby archived) straight past the review queue, review_note silently
  discarded. Fix: merge requires BOTH pages approved — "merge involves a non-approved
  page (status: …); review candidates first (approve or reject)". Contract §4 merge
  bullet scoped to approved pages
- **L1' review_note residue after approve (low)**: flips touch only the status line,
  so the note stays. Accepted by design; contract §3.3 wording made honest, and the
  viewer's metadata panel hides review_note unless the page is candidate
- **L2' dangling_links false positives in code fences (low)**: the scan now strips
  fenced blocks and inline code first (same fence rules as retrieval's chunker,
  including the ```code```-inline-line rule) — both sides agree on what counts as a link
- **L3' typo'd status invisible (low)**: plan validates the status enum; anything
  outside candidate|approved|rejected|archived lands in errors
- **L4' merge missed the [[from.md]] form (low)**: linkRe accepts an optional .md
  (form preserved in the rewrite), matching how retrieval and plan resolve links
- **L5' diff happy path untested (low)**: new viewer test with a real git-init'd KB —
  baseline from HEAD, changed=true (skips gracefully when git is unavailable)

## M4 review-fix round (2026-07-31, 82 tests all green: acquisition 4 / governance 43 / retrieval 35)

External review of M4: 5 medium + 7 low findings, all confirmed (no misjudgments), all fixed
or recorded. The review's central insight: **risk tiering was enforced only by caller
discipline (remembering --candidate / sweep-first), not by the tool layer** — now it is
enforced by both.

- **M1 re-apply silently approved a candidate (medium)**: applyTopicPage ignored the old
  page's status; re-applying a candidate page without --candidate flipped it to approved,
  bypassing review and truncating the audit narrative. Fix: a still-candidate page STAYS
  candidate on re-apply (logged `candidate:topic` + "kept candidate (pending review)") —
  approval is a review outcome only, never an apply side effect. Pinned by regression test
- **M2 sweep backfill hole (medium)**: viewer flip → governance write before sweep → the
  review record never entered log.md. Fix at the tool layer: apply-topic REFUSES to
  overwrite a page whose last log line is `candidate:*` but whose status has already
  changed ("unlogged review flip pending on this page; run sweep first"); contract §4
  amended to state the rule. The only write path that could truncate backfill is closed
- **M3 viewer gaps (medium, requirement shortfall)**: no conflict diffs, candidate reason
  invisible, topic sources evidence not clickable. Fixes: `--note` now also lands in a
  `review_note` frontmatter field (contract §3.3 amendment; shown prominently in the
  viewer, dropped when written approved); topic pages get one clickable evidence pane per
  `sources` entry; new `GET /api/diff` (read-only `git show HEAD:<page>`, graceful null
  baseline when the KB has no git history) + a client-side LCS line-diff view
- **M4 merge mechanism missing (medium, requirement shortfall)**: CONTEXT.md promised
  "merging rewrites backlinks and archives the old page". Delivered `merge-topic`:
  backlink rewrite across wiki/sources+topics (bare and topics/-prefixed forms, display
  and #anchor preserved), provenance union into the survivor, archive of the loser,
  merge log line. Plus `plan` gains a `dangling_links` list (nobody reported dead
  wikilinks — retrieval silently skips them)
- **M5 topic provenance not re-checked (medium)**: plan's orphan scan covered only source
  pages' source_ref; a raw deleted later (acquire --prune) left topic sources dangling
  silently. Fix: orphaned_pages now also scans every topic page's sources array
- **L1 boolean flag trap**: `--candidate yes` / `--prune yes` silently read as false
  (would have produced an approved page / skipped a destructive prune). Both CLIs now
  accept only bare / `true` / `false` and fail loudly otherwise
- **L2** moveToArchive comment overpromised the crash window → reworded (retrieval's
  double insurance covers it in practice). **L3** viewer oversize POST hung the client →
  413 response. **L4** statusflip/parser divergence on `status:candidate` (no space) →
  plan now surfaces wiki pages with an unreadable status in `errors` instead of letting
  them vanish from every queue. **L5** non-atomic writes (no tmp+rename) → recorded,
  accepted: KB Git is the mitigation layer. **L6** ADR-0002 drift → new
  `docs/adr/0005-rejected-transient-status-and-sweep.md`. **L7** coverage gaps → all
  M1/M2/M5 scenarios pinned by regression tests; the manual end-to-end smoke is now an
  automated CLI-level test (`e2e.test.mjs`: plan → apply-source → apply-topic
  --candidate → real viewer server reject over HTTP → sweep → rebuild-index, log
  narrative asserted line by line); acquisition gained a CLI bool-flag test

## M4 delivered (2026-07-31, 69 tests all green: acquisition 3 / governance 31 / retrieval 35)

Contract amendments (increment-compatible, contract.md/governance.md/CONTEXT.md synced):

- §3.1 status enum += `rejected` (transient; the sweep moves rejected pages into
  wiki/archive/ and flips them to `archived`); §1 write matrix: viewer flips
  candidate → approved / rejected
- §3.3 topic slug rule `/^[a-z0-9][a-z0-9-]*$/` (slug = identity; re-apply = update, never
  fork), update semantics: sources union-merge / created_at preserved / aliases+tags
  omitted = keep
- §4 state machine redrawn: candidate → rejected → sweep → archived; approved → archived is
  human-adjudicated (archive command); viewer flips are unlogged by design — the sweep
  backfills `review |` lines statelessly (last candidate:* line without a later review line),
  granularity per-sweep (double-flip between sweeps records only the final state)
- §5 log vocabulary: auto:create-topic / auto:update-topic / candidate:topic /
  review approve|reject via session|viewer|viewer (backfilled) / archive /
  auto:archive-rejected
- governance.md: new §2 topic conventions, §3 review conventions (two channels, sweep-first,
  single-operator discipline)

Key design decisions:

- **statusflip.mjs** is the viewer's ONLY write primitive: string surgery on the frontmatter
  block (never parse-reserialize) — CRLF/BOM/comments survive byte-for-byte (pinned by an
  exact-string test); the expected-from check makes a concurrent flip lose loudly (HTTP 409)
- **normalizeWikiRel** gates every wiki write path: wiki/(sources|topics)/<name>.md only —
  index.md and archive/ are unwritable by construction
- Candidate overwrite of an approved topic drops it from retrieval until reviewed; the
  pre-overwrite version is recoverable via KB Git (documented in SKILL.md)
- Viewer imports statusflip/frontmatter from governance/scripts/lib (intra-service sharing;
  the ×3 duplication rule is inter-service only)
- Retrieval untouched; a `status: rejected` regression test pins that the new enum value is
  neither indexed nor readable
- End-to-end smoke verified on a scratch KB: acquire-fixture → govern → topic → viewer
  reject (unlogged) → sweep (backfilled + archived) → rebuild-index → kb_search visibility

## Post-translation review fixes (2026-07-31, 45 tests all green)

First review round on the English-switched codebase; 4 findings, all confirmed
(1 medium severity was a translation slip):

- **CONTEXT.md thin viewer "Python script" (medium, translation slip)**: red line #1 said
  "a Python script starts localhost", contradicting the same file's tech-stack line and
  ADR-0004 ("a Node script"). The Chinese original never said Python — the translator
  introduced it. Fixed to Node. A contractual M4 description; implementing from the wrong
  one would have been rework
- **govern/acquire SKILL.md script paths (medium)**: round 3's "resolve from the skill
  install dir, never assume cwd" fix had covered only retrieval; the other two skills still
  used repo-root-relative paths, which break under plugin distribution. Unified all three to
  the `<skill-dir>/../../scripts/...` wording
- **Stale test name (low)**: `date filters: after:/before: compare updated_at` still named
  the pre-round-4 semantics; renamed to "compare the effective date (updated_at fallback)".
  Same class of issue as round 5's outdated query.mjs comment — comments/names are docs too
- **contract.md §3.4 index.md examples (low)**: examples had a space before the metadata
  parenthesis; implementation (govern.mjs rebuildIndex) and its pinned test emit no space.
  Fixed the contract examples (both Topics and Sources lines) to match the implementation,
  not vice versa — the test pins the no-space form

## Language switch: entire project now English-only (2026-07-31, 45 tests all green)

Pre-M4 housekeeping: all code comments, error messages, tests, contract, ADRs,
CONTEXT.md, SKILL.md files, package.json descriptions, and this log switched
from Chinese to pure English. Zero behavior change (verified: 3/8/34 all green
after the switch). Intentionally left as-is:

- CJK regression fixture data in tests (trigram/LIKE routing, slugify) — required
  by governance.md §1; the CJK range regex in query.mjs is functional, not prose
- `guide/` pre-M0 research notes (kept in Chinese by user decision)
- `guide/materials/` research raw materials (paper snapshots incl. `tensorowl.html`), `node_modules/`

Hazard discovered during the switch: emitting the 6-char `\uXXXX` escape text in
tool parameters gets decoded into the literal character before hitting disk —
the frontmatter BOM escape had to be rebuilt via `String.fromCharCode(92)` and
verified at codepoint level. Recorded in long-term memory.

## M3 sixth review-fix round (2026-07-31, 45 tests all green: acquisition 3 / governance 8 / retrieval 34)

1 high + 1 low, both confirmed (reproduced live: reading archived content out of `wiki/ARCHIVE/old.md`):

- **Archive gate Windows case-sensitivity bypass (high, residual from round three)**: readpage's
  wikiRoot prefix check had norm() lowercase normalization, but the archive check's normRel did
  not — path.relative is pure string arithmetic and preserves input casing. On Windows,
  `wiki/ARCHIVE/` and `wiki/Archive/` variants bypassed the archive block; stacked with the H1
  scenario (archiving without flipping status) this yielded a direct successful read — the three
  prior lines of defense (search skipping the directory / whitelist / BOM fail-closed) happened
  to all miss this path.
  Fix: normRel now goes through the same norm() normalization (one line); regression test made
  platform-conditional (win32 asserts archive blocked; case-sensitive FS asserts path not found)
- **wiki/INDEX.md whitelist false rejection (low, fail-closed)**: self-healed as a side effect
  of the same one-line fix

Lesson: two case-sensitive points within the same function must share the same normalized
product — never normalize one and use the other raw.

## M3 fifth review-fix round (2026-07-31, 43 tests all green: acquisition 3 / governance 8 / retrieval 32)

3 low findings, all confirmed: (1) skips orphan rows — toRemove changed to docs ∪ skips
dual-key reconcile (deleting a candidate page now also cleans up its skips row); (2) query.mjs
parseQuery comment was stale (still said "by updated_at"; now states the actual src_updated-
preferred semantics); (3) inline code ```code``` alone on a line was misjudged as an opening
fence — after an opening fence, the same character appearing again on the same line means it is
not a fence (CommonMark: a backtick fence's info string must not contain backticks).

## M3 fourth review-fix round (2026-07-31, 41 tests all green: acquisition 3 / governance 8 / retrieval 30)

Review report hit 2 medium + 7 low, all confirmed and fixed:

- **Medium-1 read fail-open**: a frontmatter parse failure (BOM / malformed `status:candidate`
  with no space) presented as "no status" and was let through by read — asymmetric with the
  search side's fail-closed behavior.
  Fix: readpage switched to a **whitelist** (only wiki/index.md is exempt from the status
  check; every other page must be explicitly approved); all three parseFrontmatter copies now
  tolerate BOM in sync (matching the BOM via an explicit escape sequence rather than a literal
  BOM character, to guard against editors silently stripping it)
- **Medium-2 date filter semantics**: after:/before: used to filter on governance time
  (updated_at = apply moment), so an old document "pulled in June, governed in July" was
  treated as new. Fix: docs table gains a `src_updated` column (taken from source_version when
  it is an ISO date; user_version=3 rebuild); effective date = source-system time preferred,
  falling back to governance time; SKILL.md/CONTEXT.md updated to state the semantics
- **Low**: candidates cleanup excludes the current run's file (same-millisecond mtime ties no
  longer falsely deleted); readSection includes subsections (truncated at same-or-higher-level
  headings, documented in SKILL.md); --within tolerates trailing slash; .MD uppercase extension
  (two places: read + walk); new skips table (candidate pages record hash — no more blind
  re-parsing on every ensureFresh; status flip = content change = hash change, so re-parse
  happens automatically); fence recognition for ~~~ and 4+ backticks (closing fence must use
  the same character and length ≥ opening fence); wikilinks strip #anchor for graph expansion;
  knownPaths sorted to guarantee deterministic resolution of same-name basenames

## M3 third review-fix round (2026-07-31, 20 tests all green)

Review report hit 2 high + 2 medium, all fixed with pinned regressions:

- **H1 archive leak**: ensureFresh skips `wiki/archive/` (already-indexed entries are purged
  automatically); contract §4 amended with "archiving must also flip `status: archived`" (new
  enum value, increment-compatible), §3.1/CONTEXT.md synced — retrieval-side directory skip +
  governance-side status flip as double insurance
- **H2 read backdoor**: read command extracted into `lib/readpage.mjs`; candidate/archived
  pages refused (status-less index.md allowed); SKILL.md notes read and search share the
  same gate
- **M3 path-prefix bypass**: `startsWith(wikiRoot + path.sep)` closure + path.resolve
  normalization + win32 lowercase comparison — `wiki-evil/` cannot bypass
- **M4 date filter landed**: docs table gains an `updated` column (user_version=2 whole-DB
  migration — the index is a derived artifact anyway); `after:`/`before:` compare updated_at
  in ISO lexicographic order
- Low: --within backslash normalization; --limit non-positive integer errors out; .kb/candidates
  capped at the 20 most recent with auto-cleanup; SKILL.md script path changed to resolve
  relative to the skill install directory (under plugin distribution cwd is not the repo root),
  with a note that score is heuristic-only and source: only matches source pages
- **Deferred on record**: ensureFresh re-hashes everything each run (large KBs will need
  search_state.json, already reserved in contract §1); snippets not centered on stem matches
  (degrades to the first 200 characters, cosmetic only); the vector leg (OpenAI endpoint /
  GGUF + RRF k=60) **deferred until an intranet embedding endpoint exists** — kb.json
  `retrieval.embedding` config is already defined in contract §6, not an omission

## Two earlier review-fix rounds (regressions pinned)

- frontmatter: empty arrays/objects skipped (prevents bare-key malformation), CRLF tolerated;
  three services each hold one copy (deliberate duplication, synced by hand)
- apply-source: --raw normalized (forward slashes + ^raw/ + per-segment rejection of ..),
  tags omitted = keep, writes content_hash
- plan: bad raw goes to errors; anomaly = hash changed + version unchanged (high-risk signal)
- sourcePageRelPath: source/source_id whitelist /^[A-Za-z0-9][A-Za-z0-9_-]*$/ (contract §2 in
  plain text)
- rebuildIndex: titles flattened to prevent injection
- contract §3.2 amended with content_hash (increment-compatible); log.md permissions: acquire
  may also append

## Key patterns (carried forward)

- Human-machine division: Claude does only the intellectual step (writing summaries); scripts
  do all bookkeeping (frontmatter/persisting/indexing/logging)
- Retrieval division: scripts own recall + bounding (candidate space); Claude owns precision
  (CSQE iteration, HyDE forbidden)
- Zero code dependency between services; communication only via the KB directory; retrieval
  indexes only approved pages and never touches raw/

## TODO

- **Real-environment acceptance** (next, before any M7 work): docs/real-env-test.md —
  scratch-KB checklist against the real intranet Jira/Confluence (auth/cert drills, XHTML
  fidelity audit, incremental-skip verification, governance+retrieval loop)
- **M7 candidates**: SharePoint connector (v2, Graph API + MSAL — longest chain, deferred at
  M0); vector retrieval leg (deferred until an intranet embedding endpoint exists);
  Confluence comments pull (v2); XHTML fidelity upgrades only if real corpora demand them
- ~~Repo has no .gitignore / no git init~~ (done in the M5 review-fix round)
