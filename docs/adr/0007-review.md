# ADR-0007 评审意见 — Semantic Graph Plus Navigation Tree, With Frontmatter-Derived Edges

**评审对象**: `docs/adr/0007-semantic-graph-navigation-tree.md`(Status: proposed, 2026-08-04)
**评审日期**: 2026-08-04
**评审方式**: 三个独立维度评估(可行性与代码一致性 / 改动影响面与性能 / 方案优化空间与外部先例)交叉验证,关键证据人工复核
**评审结论**: **方向可行,修订后批准(revise-then-approve),不建议按原文直接实施**

---

## 1. 总体结论

双视图(导航树 + 语义图)、从 frontmatter 派生 topic↔source 边、不动 governed wiki 内容——这三条核心决策方向正确、符合架构("索引是可重建派生物"、"UI 是纯消费者"),且有外部先例支撑。ADR 对代码现状的事实描述基本准确。

但 ADR 漏掉了两个结构性问题(**SCHEMA_VERSION bump**、**反向边与逐文件增量索引模型的冲突**),并且"双向边默认开启 + 派生边写入 `outlinks`"这一半决策集中了几乎全部实现风险。三个评估维度独立收敛到同一组修改建议(见 §6),按此修订后,绝大多数已识别风险在构建前即可消解。

---

## 2. ADR 事实核查结果

逐条比对 ADR 对代码的断言,结论:**基本属实**。

| ADR 断言 | 结论 | 证据 |
|---|---|---|
| 图边仅来自正文 wikilink,经 `ui/lib/graph.mjs` 读 `docs.outlinks` | ✅ 属实(语境段有一处小遗漏) | `ui/lib/graph.mjs:51-58`;但 graph.mjs 同时有 UI 侧 candidate 扫描(`:60-67`),语境段未提 |
| index.md 每轮 governance 重建、每页一行、连向所有节点 | ✅ 属实 | `schema/contract.md:202-215`;`governance/scripts/lib/govern.mjs:362-368`;index.md 不在 sqlite 索引内(`store.mjs:143`) |
| topic 页仅以 `sources:` frontmatter(raw 路径)记录来源,无任何消费方读取 | ✅ 属实 | `schema/contract.md:185-188`;`govern.mjs:321`;`indexDoc` 只抽取正文 wikilink(`store.mjs:90`) |
| source 页 `## Related Topics` 为纯文本、可悬空 | ✅ 机制确认;`order-lifecycle` 实例无法验证 | `governance/skills/govern/SKILL.md:85`;纯文本不经 `resolveLinks`(`store.mjs:65-75`),悬空在结构上可能;仓库内无 KB 实例,该例应标注为观察而非可验证事实 |
| candidate topic 页不入索引 | ✅ 属实 | `store.mjs:81`(status ≠ approved 跳过);archive/ 整体排除(`store.mjs:146`) |
| `indexDoc` 是唯一注入点,三个消费方共享 `docs.outlinks` | ✅ 属实 | 生产:`store.mjs:77-115`(仅由 `ensureFresh` 调用,`:174`);消费:`graph.mjs:51-58`、backlinks(`graph.mjs:74-85`)、query 扩展(`query.mjs:140-152`) |
| 派生函数可在 store.mjs 与 graph.mjs 间共享、无需复制 | ✅ 可行,有先例 | `graph.mjs:19-20` 已在 import retrieval 层的 `resolveLinks` 等;`store.mjs:62-64` 注释明确"one caliber, one implementation";跨层 import 不违反"三服务零代码依赖"(该约束只绑三个服务,UI 是独立控制台) |
| `views/graph.js` 存在 | ✅ 属实,路径为 `ui/public/views/graph.js` | 单一力导向画布,尚无 tab;`isIndex` 标记已在数据层存在(`graph.mjs:31`),语义视图排除 index.md 成本极低 |

---

## 3. 错漏点(按严重度)

★ = 两个独立评估维度分别发现,交叉确认。

### P0 — 结构性缺陷

**3.1 ★ 反向边(source→topic)与逐文件增量索引模型冲突,会产生永远不会自动清理的陈旧边**

`ensureFresh` 的失效判定按**文件自身** mtime+size/hash(`store.mjs:158-167`,已人工复核),`indexDoc` 是单文件视角(`store.mjs:77`)。若反向边物化进 source 页的 `docs.outlinks`:

- topic 的 `sources:` 变化 → 只有 topic 行更新,source 行里的反向边直到该 source 文件自己改动前都是脏的;
- topic 被 approve → topic 重索引,但 source 未动 → 反向边**缺失**,直到 source 下次编辑或全量重建;
- topic 被 rejected / archived / merged(merge 会合并 provenance 并归档败者,`contract.md:258-261`)→ source 页残留指向死 topic 的边;
- 最尖锐的情形:candidate topic 是图节点(`graph.mjs:33-42`),陈旧的 S→T(candidate) 边会**渲染在图里**并出现在 T 的 backlinks 面板——正是"不该存在的溯源声明"。

ADR 对此只字未提。现有的"frozen outlinks"注意事项(`graph.mjs:11-13`)是为作者边写的;派生反向边把冻结从个别情况变成系统性问题。

**3.2 ★ 反向边所需数据索引里根本没有,而获取它会复活刚修掉的性能回归**

`docs` 表无 `sources:` 列(`store.mjs:36-39`)。正向边(topic→source)可用 `docs.source_ref` 纯 SQL 派生,**零磁盘 I/O**;反向边必须扫全部 approved topic 的 frontmatter。若在每次 `ensureFresh` 中做此扫描,恰好复活了 2026-08-04 review 刚修掉的"每次请求 O(N 文件)磁盘读"回归(`store.mjs:14-21` 注释记录了该修复的动机)。

**3.3 ★ 缺 SCHEMA_VERSION bump 要求**

增量对账按文件 hash 跳过未变文件(`store.mjs:166-167`)。不 bump 版本(当前 5,`store.mjs:22`)或强制重建,存量 approved 页将**无限期**停留在"仅 wikilink"的旧边模型——索引进入混合状态,图/backlinks/扩展行为取决于每个页面的编辑新旧。ADR 的"docs 表是可重建派生物,所以格式/列变更安全"(line 54)本身正确,但不完整:bump 必须写进决策。

### P1 — 规格缺口

**3.4 ★ join 口径未定义**

ADR 称 `sources:`(raw 路径)经 `source_ref` 关联到 `wiki/sources/*.md`。但:

- 测试夹具已出现非 raw 路径的宽松写法(`ui/test/ui.test.mjs:32` 用 `local-aaaa1111-pay.md` 对 `source_ref: 'raw/local/aaaa1111-pay.md'`);
- 现有 raw→wiki 关联(`ui/lib/browse.mjs:44`,`rawRefs`)需要 `endsWith(basename)` 兜底,证明真实数据是松的。

exact-match 会静默丢边;basename 兜底会遇到不同来源系统的同名文档碰撞。ADR 必须定口径。建议:exact-match 为主,丢边计数进 `plan()` 异常面上报(对比:悬空 wikilink 已是 `browse.mjs:70` 的一等公民),不静默丢弃。

**3.5 index.md 排除必须是纯视图层**

`ui/test/graph.test.mjs:50,62,70` 断言 index.md 是节点、有 hub 边、出现在 backlinks。ADR 字面"The semantic graph excludes index.md entirely"(line 24)容易诱导在 `buildGraph` 层排除——那会同时砍掉每页最大的 backlink 来源,并使 backlinks 面板缩水。实施项 4 把排除放在 `views/graph.js`(正确),但 ADR 正文应明确此边界。

**3.6 kind 标记与 outlinks 字符串数组格式冲突**

两个 JSON.parse 消费方(`query.mjs:146`、`graph.mjs:57`)均假设纯字符串数组。评审项的"区分派生边 vs 作者边"需要格式变更或新列,未列入实施清单(Implementation shape 6 项中无此项)。

**3.7 portal 搜索 UX 影响未提**

`ui/lib/search.mjs:12-18` 进程内调用 retrieval 的 `search()`;派生边邻居会以 `via:'link'` 芯片出现在门户搜索视图(`ui/public/views/search.js:47,178-182`)。ADR 只提了 graph / backlinks / retrieval CLI 三面。

**3.8 文档漂移已在发生**

`CONTEXT.md:169-171` 已把 ADR-0007 的行为写成既成事实("outlinks include frontmatter-derived provenance edges (ADR-0007)"),而 ADR 仍是 proposed、代码未动。评审若改判或修改决策,CONTEXT.md 必须同步回滚或修订。

### P2 — 一致性风险

**3.9 candidate topic 的图方向不对称**

candidate 不入索引(`store.mjs:81`),其反向边永远进不了 `docs.outlinks`。图里会出现 candidate-T→S 正向边却无 S→T 反向边;candidate topic 的 backlinks 来源不全,除非 UI 侧扫描也派生反向边——ADR 未说明。

**3.10 索引事务内的时序窗口**

若在 `indexDoc` 内做跨行 UPDATE 写反向边:`toIndex` 循环按路径排序(`store.mjs:171`,`sources/` 先于 `topics/`),bulk 首索引时 join map 必然不完整;两种顺序都会留下窗口。需要显式的两遍扫描或事务后对账——不在实施清单中。**ADR 选定的注入点(`indexDoc`)恰好是保证 join map 不完整的位置。**

---

## 4. 性能影响评估

| 维度 | 结论 |
|---|---|
| 索引体积/重建成本 | 双向边约 +2× 溯源对数;2k 页规模(`views/graph.js:11` 的 MAX_AUTO)下为几千个短字符串,**可忽略**。真正成本在派生 map 的构造方式(见 3.2) |
| 查询扩展 | 现有护栏保住排序:top-10 扩展源(`query.mjs:142`)、单跳(`:144`)、去重(`:143,148`)、`allowedDocs` 过滤(`:147`)、via:link 附加于全部命中之后(`:150`)、score:0 不挤排名。**但单页扇出无上限**:一个 50 源的 topic 命中追加 50 条候选,10 个枢纽 ≈ 500 条;`total`、候选落盘文件、门户完整候选渲染均随之无界增长 |
| 图渲染 | 2000 节点守卫已存在(`graph.js:11,330-337`);力导向 ~O(N)+O(E),几千条新增边无压力;`/api/graph` 载荷线性增长,可接受 |
| eval 回归 | Hit@1/5/MRR 从 preview 计算,via:link 附加物在指标盲区,0.85 门禁(`tests/eval/retrieval-eval.test.mjs:15,111`)**结构性不受影响**;q09/q10/q12/q13/q16 均受 `allowedDocs` 保护;q14 的 `expectViaLink` 为存在性断言,仍过。但几乎所有 query 的 `total` 与候选文件内容会漂移,报告 diff 噪音大 |

**关键判断**:性能风险不在"边多",而在两处——(a) 反向边派生的实现方式可能复活 O(N) 磁盘扫描(3.2);(b) 扩展扇出无上限导致候选空间稀释。两者都有廉价的修法(见 §6)。

---

## 5. 外部先例调研

| 工具 | 派生/隐式关系的处理方式 | 对本案的启示 |
|---|---|---|
| Obsidian(core) | unlinked mentions 按需计算,在 backlinks 面板中**独立折叠区块**,从不并入 linked backlinks;frontmatter 中的链接有意不计入 backlinks/图 | 派生 ≠ 作者,分区展示是惯例;frontmatter 关系不污染链接图有先例 |
| Dendron | 作者链接 + 文件名派生的层级边在**读时合并**,各自独立开关、独立边数统计、独立 CSS class | kind 可由存储/来源位置携带;per-kind 开关可直接借鉴到 `views/graph.js`(已有候选/孤立点开关,`:24-25`) |
| Foam | 整个图在视图时从 workspace 内存构建,不物化任何边 | 读时推导在该规模下完全可行 |
| Breadcrumbs(Obsidian 插件) | 反关系自动推导("A 是 B 的 up ⇒ B 是 A 的 down"),声明的边只存一次 | 反向边应计算而非存储 |
| qmd(CONTEXT.md 点名的参考实现) | 无图物化管线 | 与本仓库"no offline graph-building pipeline"(`CONTEXT.md:180-182`)一致 |

**收敛结论**:可类比的工具中,没有任何一个把派生/隐式关系物化进与作者链接相同的边存储;反关系无一例外是计算得出的。ADR 的"物化进 `outlinks` + 双向默认开启"与此惯例相反。

---

## 6. 方案优化建议(三维度交叉收敛)

**6.1 只物化正向边(topic→source),反向边读时计算——不存反向边**

- backlinks 本来就是扫 `e.to === page` 算反向的(`graph.mjs:79-83`),物化反向边 100% 冗余,还会让语义图每条边画两遍;
- query 扩展已把全部 docs 载入内存(`query.mjs:54`),O(N) 建反查表在 2k 页规模免费;
- 一次解决 P0-3.1、P0-3.2、P2-3.9 三个问题。
- "bidirectional default-on"应保留为**行为**默认(source 命中可带出 covering topics),但实现改为读时反查,而非存储双向。

**6.2 派生边放独立列(如 `provlinks`),不污染 `outlinks`**

- kind 由存储位置携带,两个 parse 点字节兼容、零格式迁移;
- 语义上 `outlinks` = "本页作者出链"的既有含义不被按页类型翻转;
- 列新增 = SCHEMA_VERSION 5→6,重建成本为零——ADR 的"可重建所以安全"论据同样适用,不构成合并列的理由;
- 若评审坚持单列,则必须同步 bump schema 并改两个消费方 + 全部测试夹具。

**6.3 注入点从 `indexDoc` 内部改为事务后的派生 pass**

- 事务结束后 `docs` 表的 `source_ref` 全集就绪,一次 pass 完成 join,解决 3.10 的时序窗口;
- 仅在 `toIndex` 非空时执行,避免每次请求的全量扫描;
- 共享函数放 `retrieval/scripts/lib/store.mjs`(或同级 lib),UI 侧 import——与 `resolveLinks` 先例一致;**不要**放 `frontmatter.mjs`(那是有意的三方手写同步副本,`frontmatter.mjs:2-4`)。

**6.4 视觉与面板惯例修正**

- ADR 建议"派生实线、作者虚线"(line 67-68)与惯例相反,应改为**作者边实线、派生边虚线**(显式 > 隐式);`draw()` 中一行 `setLineDash` 即可;
- backlinks 面板建议分两组(引用 / 覆盖来源)而非单列表打标(`ui/public/views/browse.js:160-163` 当前为单一平铺列表);
- `via:'link'` 标注区分:派生邻居标 `via:'provenance'`,让主用户(LLM agent)能区分权重。

**6.5 检索扩展护栏**

- 加每页扇出上限(与 "bidirectional default-on" 并列的 tuning knob);
- 把"候选空间稀释"列为 retrieval-eval 的显式观察指标——现有 0.85 门禁会通过,但会通过得"不明不白"(via:link 附加物在 Hit@5 指标盲区)。

**6.6 导航树维持节点扫描驱动,不解析 index.md**

- Topics/Sources 分组与 index.md 的合同结构(`contract.md:204-212`)天然 1:1;目录树即类型系统,无中间层级;
- 解析 index.md 等于为一个生成物写第二个 parser 去重新推导 frontmatter 里已有的权威数据;candidate 状态徽标也需要节点扫描才有;
- index.md 独有的是每页一句话摘要,可作为后续 tooltip 增强,不作为树的数据脊柱。

---

## 7. 修订清单(给评审门)

| # | 修订项 | 解决的问题 |
|---|---|---|
| 1 | 只物化 topic→source;反向在 backlinks / 扩展内读时计算(双向行为默认保留,存储单向) | 3.1, 3.2, 3.9 |
| 2 | 派生边独立列(如 `provlinks`);SCHEMA_VERSION 5→6 写进决策 | 3.3, 3.6 |
| 3 | 注入点从 `indexDoc` 改为事务后派生 pass;`toIndex` 为空则跳过 | 3.10, 3.2 |
| 4 | 定义 join 口径:exact-match 为主;丢边计数进 `plan()` 异常面,不静默 | 3.4 |
| 5 | 明确 index.md 排除与 kind 标记均为视图/表现层,不动 `buildGraph` 与 outlinks 合同 | 3.5, 3.6 |
| 6 | 派生邻居标 `via:'provenance'` + 每页扩展扇出上限;eval 增加候选稀释观察指标 | §4 性能护栏 |
| 7 | 实线 = 作者边 / 虚线 = 派生边;backlinks 面板双分组(引用 / 覆盖来源) | 惯例与可读性 |
| 8 | 回滚或暂缓 `CONTEXT.md:169-171` 的既成事实表述,与最终裁决同步 | 3.8 |
| 9 | 新增测试夹具覆盖派生边(现有 `graph.test.mjs:63` 的 `edges.length === 3` 之所以活着,只是因为夹具没有 `sources:`) | 测试盲区 |

---

## 8. 一句话总结

双视图 + frontmatter 派生是对的方向,ADR 的事实基础扎实、注入点思路可行;但"双向物化进 `outlinks`"应改为"**正向物化独立列 + 反向读时推导 + schema bump**",并按 §7 补齐 join 口径、视图层边界、扩展护栏与测试覆盖——这样几乎所有已识别风险在构建前就消解了。
