# 实施计划：治理层冲突检测与裁决（bug 0001）

**状态**：设计已定（ADR-0008），待实现。本计划面向审核人。
**范围**：governance 服务 + UI portal 评审流程 + 契约/文档同步。**不改** retrieval 代码（v1 无 topic 优先）、**不改** acquisition 代码。
**问题原文**：`docs/bugs/0001-governance-version-conflict-not-detected.md`

---

## 0. 审核响应（2026-08-05，外部审核一轮）

对 `docs/adr/0008` + 本计划 + bug 文档的三份审核共 10 条发现，**逐条对照代码核实，全部属实**，已并入本版。优先级：P0-1、P0-2 方案级缺陷必修；P1-3~6 纳入 v1；P2-7~10 文档/契约/知情接受；P3 为实现注意事项。

| 编号 | 问题 | 核实 | 处置 |
|---|---|---|---|
| P0-1 | 归档败方后 plan() 重新 pending → 每轮复活 | ✅ 属实（govern.mjs:104-105 pending 判定 + moveToArchive 移出 sources/） | §3.1.6 墓碑抑制 |
| P0-2 | 预筛"同 source"= 连接器名，退化全库 O(n²) | ✅ 属实（rawdoc.mjs source=local/jira/confluence） | §2 预筛改写 |
| P1-3 | 软逃逸无持久化，同一组永久重复 flag | ✅ 属实 | §3.1.7 驳回记录 |
| P1-4 | conflicts.json 无新鲜度校验，过期比缺失更糟 | ✅ 属实 | §3.1.4 指纹 |
| P1-5 | UI reject-restore 不写 log → sweep 误补记 approve | ✅ 属实（serve.mjs:324 只 flip + govern.mjs:450-459 回填） | §3.1.5 restore 同步 log |
| P1-6 | token-set Jaccard 对中文失效 | ✅ 属实 | §2 CJK shingle |
| P2-7 | 归档不改写 backlink / provlinks 边消失 | ✅ 属实（moveToArchive 无改写，merge-topic 才有） | §5 声明为已接受 |
| P2-8 | 契约"1:1 / always approved"被打破但契约未列入改动 | ✅ 属实（contract.md:151,157） | §3.3 契约修订 |
| P2-9 | "全库"比较空间边界未定义（orphan/summary） | ✅ 属实 | §2 比较空间定义 |
| P2-10 | factual-conflict 纯语义路径无机械兜底 | ✅ 属实（与 bug 根因同类残留） | §3.1.4 semantic_check_required |

二轮复核（2026-08-05）：10 条处置全部核验通过，可进入实现。复核补充的 6 条 P3 实现事项已并入：§2.2（hash 缺失防御）、§3.1.2（指纹缺 hash 兜底）、§3.1.3（log target 语义 / `--force` 清墓碑）、§3.1.4（指纹重算成本）、§5（同批双新顺序 / 悬空墓碑清理），并同步修订了 bug 文档的 Resolution 小节（此前仍描述修订前设计）。

---

## 1. 设计摘要（详见 ADR-0008）

治理层检测三类跨文档冲突，范围是**全库**（本次 pending + 已导入未治理 ↔ 所有已有，含已 approved）：

| 类别 | 机械信号 | 执行 |
|---|---|---|
| **完全重复** | `content_hash` 完全相同 | `apply-source` 时**先查重、不写页**，直接墓碑 + log（`govern \| auto:dedup-source`）；topic 引用一份 |
| **内容相近** | 预筛（标题相同 / 标题 token 重叠 / 文件名去版本后缀相同）+ 正文相似度确认（Latin token + CJK shingle，混合取并集） | `apply-topic` **强制 candidate**（fail-closed） |
| **内容冲突** | 语义（无机械信号）：新文档 vs 已有 topic 内容逐条对照 | `apply-topic` 强制 candidate + 冲突点写入 `review_note` + 输出 `semantic_check_required` 提示 |

裁决结果：人定权威版本 / 谁对 → **败方 source 页归档**（默认动作，移出检索）+ **墓碑抑制复活**；「拒绝」= **拒绝并恢复上一版**（从 git 拉回被覆盖的 approved 版，同步写 log）。

**持久化状态**（新增三份 `.kb/govern/` 派生态，把"已裁决"变成系统记忆）：
- `source-tombstones.json`：归档的 source 页对应 raw → plan 不再 pending、apply-source 拒写（需 `--force`）；
- `conflict-dismissals.json`：被裁决"平行文档（非版本）"的组 → plan 不再 flag、apply-topic 跳过；
- `conflicts.json`：plan 写（含 `generated_at` + raw 集合指纹），apply-topic 读，**指纹不匹配即降级**。

**内容冲突的两条触发路径**：
- 相似触发（机械）：相近组检出 → candidate → LLM 读两份差异，归类「版本演进」或「内容矛盾」；
- 不相似触发（纯语义）：靠 **`semantic_check_required` 机械提示 + SKILL.md 硬规则 + 可选 `GOVERNANCE.md` 常驻指令**——降低对 LLM 自觉的依赖（P2-10）。

---

## 2. 冲突检测规格（signals）

### 2.1 比较空间（P2-9 定义）

- 比较全集 = **`raw/` 全部文档**（本次 pending + 已导入未治理 + 已治理，含已归档对应的 raw）；
- **orphan 页（raw 已消失）例外**：其 raw 不在比较空间，新文档与之重复/相似检测不到（孤儿场景少，可接受，写入 SKILL 已知限制）；
- **source 页摘要不参与机械相似度**：摘要是 LLM 蒸馏短文本，与原文 Jaccard 必然低；已治理内容通过"source 页与 raw 1:1"的传递覆盖（P0-1 修复后该传递成立——被归档页的 raw 仍在比较空间，行为正确）。

### 2.2 信号

- **完全重复**：两 raw 的 `content_hash` 相等。确定性、零误报。**仅当两侧都含 `content_hash` 时才比较**——该字段不在 `RAW_REQUIRED`（govern.mjs:44）中，可缺失；任一侧缺失即不参与 dup 判定（null == null 绝不是 dup）。
- **内容相近**：
  1. **预筛**（廉价，作用于标题/文件名，不做正文；P0-2 修正，不再用"同 source"——source 是连接器名，对 local 全库退化）：
     - 标准化标题相等（空白折叠、小写）；
     - **标题 token 集合重叠**（标题 Jaccard ≥ 0.3，或一方 token 集包含于另一方）；
     - **文件名去版本后缀后相同**（`pay-timeout-v1.md`/`pay-timeout-v2.md` → 去 `-vN`/`(N)` 等后缀 → `pay-timeout`；覆盖 bug 0001 命名模式）；
     - 若预筛桶仍过大，加**桶大小上限**并在 plan 输出报告降级（防 2000 篇同题退化）；
  2. **确认**：正文相似度 = Latin token-set Jaccard ∪ CJK 字符 bigram/trigram shingle 的 token 集（P1-6），Jaccard ≥ 阈值；
  3. 阈值**由 fixture 校准**（P3-5）：N 对版本文档（应检出）+ M 对同标题平行文档（不应检出），取两类分布最大间隔中点；不拍脑袋定 0.6；
  4. 「Overview」同标题撞车 → 预筛过、正文相似度低 → 不标记。
- **内容冲突**：无机械信号。语义检查在 `apply-topic` 时执行，参照物**只有已有 topic 内容**（不含 GOVERNANCE.md）。

---

## 3. 文件级改动

### 3.1 governance 服务

1. **新增 `governance/scripts/lib/similarity.mjs`**
   - `normalizeBody(text)`：去 frontmatter；Latin 部分空白词元化，CJK 部分按字符 bigram/trigram 切 shingle，混合取并集；滤 ≤1 字符 Latin token；
   - `jaccard(a, b)`；
   - `findGroups(rawDocs, { threshold })`：按预筛（标题同 / 标题 token 重叠 / 文件名去版本后缀同）分组后两两算正文相似度，返回 `{ category, raws: [...], score }` 组。

2. **修改 `governance/scripts/lib/govern.mjs` — `plan()`**
   - 返回第 7 个列表 `conflicts`（组 + 类别 + score + 对侧 provenance：对应 source 页路径、被哪些 topic 引用）；
   - 全库两两比较：hash 相等 → dup；预筛 + 正文相似度 → similar；
   - **读取 `source-tombstones.json`**：命中墓碑的 raw **不列 pending**，单独列入新增 `suppressed` 报告项（可见，不静默）；
   - **读取 `conflict-dismissals.json`**：已驳回组不 flag（可标 `dismissed: true` 保持审计可见）；
   - 幂等写 `.kb/govern/conflicts.json`（含 `generated_at` + **raw 集合指纹** = 全部 raw rel + content_hash 排序后 sha256；**缺 hash 的 raw 以文件内容现算 sha256 兜底**——`content_hash` 非必需字段，见 §2.2）。

3. **修改 `governance/scripts/lib/govern.mjs` — `applySourcePage()`（完全重复 auto-dedup）**
   - **先查重**（P3-1/P3-3）：新 raw 的 hash 与全部 raw 的 hash 比对（raw 层，不依赖 source 页 frontmatter hash 未被手改）→ 命中且对侧已有 approved source 页 → **不写 source 页**，直接写墓碑 + log `govern | auto:dedup-source`（**log 的 target = 存活页路径**，冗余 raw 注于 note——不写页后每行 target 仍保持页路径语义，便于 grep 审计）；
   - 命中墓碑 → 拒绝写入，提示需 `--force` 复活；**`--force` 写页成功后同步清除该 raw 的墓碑**（避免"页存在 + 墓碑存在"的不一致态）；
   - 无重复/墓碑 → 正常写 approved。

4. **修改 `governance/scripts/lib/govern.mjs` — `applyTopicPage()`**
   - 读 `.kb/govern/conflicts.json`；**先校验 raw 集合指纹**（P1-4）：不匹配 → 与缺失同等降级（只查本 topic `sources` 内部两两）+ 输出告警 `conflicts side-channel stale, degraded to in-topic check`。指纹重算需 walk 全 raw/ 读 frontmatter，M 次 apply-topic 即 O(M×N)——典型 KB 可接受；若在意，在 conflicts.json 附带 `(rel, hash)` 清单，apply-topic 只做 stat 级（mtime/size）校验（实现注释）；
   - 任一 new source 落在 flagged similar/conflict 组（跳过已驳回组）→ **强制 `candidate`**（忽略调用方未传 `--candidate`），`review_note` 注明所属组；
   - `sources` 内出现 hash 相同的对 → 收敛为引用一份（保留已存在且 approved 者，否则字典序首个），log `govern | auto:dedup-topic`；
   - **`semantic_check_required`**（P2-10）：任一 new source 的标题/token 与已有 topic 的 title/aliases 重叠时，输出 JSON 附加 `semantic_check_required: [<topic slugs>]`——不改变 status，只把"自检"变成输出契约。

5. **修改 `governance/scripts/lib/govern.mjs` — `rejectPage()`（拒绝并恢复上一版）**
   - 新增 `restorePreviousApproved(kbRoot, rel)`：先探测 git（`git rev-parse --is-inside-work-tree`，P3-2），`git log` 逐次取 `git show <commit>:<rel>`（**rel 必须 posix 化**）找最近 `status: approved` 版本 → 写回文件 + 置 approved；
   - **写回后同步写 log**（P1-5，顺序关键：先 restore 再 `review | reject | <page> | restored previous approved version`，保证 `lastLogAction` 不是 `candidate:*`，sweep 才不会误补记 approve）；
   - 找不到 approved 版（新 topic 从未 approved）→ 现有普通拒绝；警告文案**区分"非 git"与"git 历史不足"**；
   - restore 写回内容本身带 `status: approved`，再用 `flipStatus` 置 approved 时核对 from-status 读取语义（P3-2）。

6. **新增 `governance/scripts/lib/govern.mjs` — 墓碑/驳回写入**
   - 归档败方 source 页时（败方归档、auto-dedup）同步写 `source-tombstones.json`（key = raw 相对路径，值含归档时间、原因、归档页路径）；
   - 新增 `dismiss-conflict` 动作（CLI 子命令，写 `conflict-dismissals.json`），UI 评审提供"保留两者"按钮走同文件（P1-3）。

7. **修改 `governance/scripts/govern.mjs`（CLI）**
   - `plan` 输出含 `conflicts` + `suppressed`；`reject` 走 restore 语义；新增 `dismiss-conflict --pair raw/a,raw/b --reason "..."`；`apply-source` 支持 `--force`（复活被墓碑抑制的页）。

8. **修改 `governance/skills/govern/SKILL.md`**
   - step 2：`conflicts` + `suppressed` 清单必须处理或上报（plan 现为六清单，变八清单）；
   - step 3：**强制冲突自检**——合成 topic 前把新文档与已有 topic 内容逐条对照，矛盾写进 `--note` + `--candidate`；`semantic_check_required` 列出的 topic 必须人工比对；不相似文档的矛盾也要自检；
   - step 4：拒绝 = 拒绝并恢复上一版；败方归档为默认动作（软逃逸 → dismiss）；**归档后检查 dangling_links**（P2-7，归档不改写 backlink，悬空链接由人修）；
   - 备注：可选在 `GOVERNANCE.md` 写常驻指令（服务端每次注入）。

### 3.2 UI portal（`ui/`）

1. **修改 `ui/serve.mjs`**
   - `/api/review`：`reject` 动作接入 restore 语义并**同步写 log**（`portal | reject | ... | restored`——打破"viewer 不写 log"惯例，restore 是实质内容变更，理应立即记账）；新增 `archive-source` 动作（归档一个 approved source 页 + 写墓碑）；新增 `dismiss-conflict` 动作；
   - 新增 `/api/conflicts`（读 `.kb/govern/conflicts.json`，F4 banner 用；P3-4 补漏）。

2. **修改 `ui/public/views/queue.js`**
   - 评审 bar 增为五态：✓ 批准 / ✗ **拒绝并恢复** / ✎ **编辑**（复用现有 kbfile-edit，候选保持 candidate 后再批准）/ **归档来源** / **保留两者（dismiss）**；
   - 冲突候选渲染：高亮 `review_note` 冲突点、来源旁的"归档"按钮；F4 banner 纳入 `conflicts` + `suppressed`。

### 3.3 契约与文档（P2-8，必做）

- **`schema/contract.md` 修订**：`wiki/sources/` 的"1:1 with raw documents"（:151）改为"**1:1 为默认，裁决归档/精确去重为例外**"；source 页"always approved"（:157）加**归档例外条款**（败方归档、auto-dedup、墓碑抑制）；
- **`CONTEXT.md` 术语表更新（升级为必做）**：把承诺但未实现的 dedup/candidate 行为兑现为三类术语 + 墓碑/驳回状态；
- **`governance/scripts/lib/govern.mjs` 头注释**同步（1:1 例外）；
- **`.kb/` 归属划清（P3-7）**：`retrieval/scripts/lib/store.mjs` 头注释"exclusively written by the retrieval service"已不成立（portal 已写 `.kb/ui/`）——修订为：retrieval 拥有 `index.sqlite`，governance 拥有 `govern/`、`bodies/`，portal 拥有 `ui/`；写入 contract §1。

---

## 4. 评审流程状态机（动作 → 终态）

| 评审动作 | 场景 | 终态 |
|---|---|---|
| ✓ 批准 | 候选的合成即裁决后的真相 | topic → approved |
| ✗ 拒绝并恢复 | 候选覆盖了 approved topic，且旧说法正确 | topic 恢复为上一 approved 版（git）；写 `review \| reject (restored)` log |
| ✗ 拒绝（普通） | 新 topic / 非 git / 无历史 approved 版 | topic → rejected → sweep 归档 |
| ✎ 编辑后批准 | 双方都有问题，正文需修正 | 正文改 → approved |
| 归档来源（败方） | 裁决后输的那份 | source 页 → archived + 墓碑；移出检索且不再复活 |
| 保留两者（dismiss） | 裁决者判定两文档平行（非版本） | 组写入 conflict-dismissals，不再 flag / 强制 candidate |

---

## 5. 边界情况

- **非 git KB**：无法恢复上一版 → 拒绝降级为普通拒绝 + 警告（区分"非 git"与"git 历史不足"）；
- **归档复活（P0-1）**：墓碑抑制——归档败方/auto-dedup 后，下轮 plan 不再 pending、apply-source 拒写（`--force` 复活）；复活-再归档循环不再产生 `foo-2/foo-3` 垃圾（archiveTarget 命名碰撞旁证消解）；
- **平行文档（P1-3）**：dismiss 持久化——下轮不再 flag / 不强制 candidate；
- **侧信道过期（P1-4）**：指纹不匹配 → 降级 + 告警（过期比缺失更糟，缺失会降级，过期不会）；
- **同标题撞车**（两个 "Overview"）：正文相似度低 → 不标记；
- **新 topic（未覆盖 approved）**：拒绝 = 普通归档，无需恢复；
- **hash 相同对且已被其它 topic 引用**：auto-dedup 先查跨 topic 引用——topic 引 raw 路径不受 source 页归档影响，仅确认被归档页未被唯一引用；
- **只跑 apply-topic 未跑 plan**：侧信道缺失/过期 → 降级为 topic 内部两两检查（拦同组内相近，拦不了"对存量"组）+ 告警；
- **中文正文（P1-6）**：CJK shingle 并入相似度，中文 v1/v2 对必须检出；
- **归档的副作用（P2-7，声明为已接受）**：指向被归档页的 wikilink 会成为 dangling_links（下轮 plan 浮现，SKILL step 4 裁决后检查）；provlinks 图边消失（与"移出检索"语义一致）；
- **同批精确重复双新**：同批 v1/v2 均无 source 页时，存活份由 apply-source 调用顺序决定（结果正确但任意）；人可 `--force` 反转选择；
- **悬空墓碑**：raw 被 prune 消失后其墓碑成为悬空记录——plan 顺带清理（或列入 `suppressed` 报告项注明 raw 已消失）。

---

## 6. 测试计划

- **unit（governance）**：
  - `similarity.mjs`：Latin token + CJK shingle 的 Jaccard、预筛三条件、撞车误报（Overview 不标记）、**中文 v1/v2 对必须检出、中英混排对检出**（P1-6）；
  - `plan`：conflicts（批内 dup/similar、对存量、provenance 字段）、**墓碑 → 不 pending 入 suppressed**（P0-1）、**dismiss → 不再 flag**（P1-3）、比较空间边界（orphan/摘要不参与，P2-9）；
  - `apply-source`：**先查重直接墓碑不写页**（P3-1）、墓碑拒写 + `--force` 复活、hash 比对走 raw 层（P3-3）；
  - `apply-topic`：fail-closed（含未传 --candidate）、**指纹不匹配降级 + 告警**（P1-4）、dismiss 组跳过、`semantic_check_required` 输出（P2-10）、hash 对收敛；
  - `rejectPage`：restore（git 历史）、新 topic 普通拒绝、非 git 降级、**restore 后 log 顺序（lastLogAction 非 candidate:*）**（P1-5）；
  - **性能**：1000 篇同 source 文档的 plan 耗时上限（P0-2）。
- **集成**：bug 原 repro（v1/v2 同批进入）→ plan 出 conflicts → apply-topic 结果 candidate 而非 approved；**归档败方 → 下轮 plan 不出 pending → apply-source 被拒/跳过 → 收敛（无重复 pending、无重复 log）**（P0-1）；
- **UI**：评审五态（批准 / 拒绝并恢复 / 编辑后批准 / 归档来源 / 保留两者）端到端；**UI reject-restore → sweep → log 不得出现 backfilled approve**（P1-5）；归档败方 → 下轮 plan 的 dangling_links 报告符合预期（P2-7）；
- **回归**：现有 `apply-topic` candidate 保护测试、`sweep`、`merge-topic` 不回归。

---

## 7. 开放问题（请审核确认）

1. **阈值校准 fixture 化**（P3-5）：构造 N 对"版本文档"（应检出）+ M 对"同标题平行文档"（不应检出），阈值取使两类分开的最大间隔中点；不再拍 0.6；
2. **自动归档（dup）前的跨 topic 引用安全检查**边界（§5 已列行为，需确认实现粒度）；
3. **`GOVERNANCE.md` 常驻指令模板**是否随本计划提供；
4. **P2-10 的 `semantic_check_required`** 是否纳入 v1（建议纳入——低成本把 LLM 自检变成输出契约）。
