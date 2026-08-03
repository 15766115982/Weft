# WebUI 需求清单(**已冻结** 2026-08-02)

> 状态:**已冻结**。新想法走变更流程,不再追加。
> 里程碑(用户已确认):**M7a** 只读全套(A-D + J1-J5)→ **M7b** 采集控制台(E-G + J6)→
> **M7c** 治理可视化(I + D5)→ **M7d** wiki 编辑 + 版本管理定型(H + J7)→
> **backlog**(K 评测 / J9 闭环 / C5 批量 / B5 查询历史 / A7 图谱)。
> **变更记录(2026-08-02,质量审核 M7a-review 后用户裁决)**:
> ① J3/J4/J5 由 M7a 正式挪至 **M7b**(与 jobs.mjs/fs-watch 一起设计);
> J3 以过渡形态在 M7a 先行(写后刷新 + health 30s 轮询 + 手动刷新钮);
> ② A5 升级为**并排分屏对照 + raw→wiki 反向溯源**(2026-08-02 交付,与 G5 共用 frontmatter 扫描);
> ③ Node 版本钉 20.x(better-sqlite3 ABI 锁定),engines ^20。
> **交付记录(2026-08-02):M7a(A-D 全套)与 M7b(E-G + J3-J6 + I6 作业中心)均已交付**;
> J3 最终形态为 fs-watch + SSE(.kb 排除 + 400ms 防抖),30s 轮询保留为 SSE 失效兜底。
> **裁决记录(2026-08-02,M7c 开工前用户拍板)**:
> ④ headless 权限姿态 = **`--dangerously-skip-permissions`**(缓冲:candidate 评审 +
> 作业日志双保险;"被拦但 exit 0" 的假成功比放开写更难缠);
> ⑤ A7 关系图谱**不并入 M7c**,M7c 先做执行器本体,图谱紧随其后单独小里程碑。
> **裁决记录(2026-08-02,M7c 外部审核后)**:
> ⑥ **skip-permissions 残余暴露面立项加固**(M7d 前):agent 文件工具不受 cwd 限制,
> prompt 注入可写 KB 外(绕过 candidate 评审 + wiki 痕迹双保险);加固方向 =
> --allowedTools/permissions.deny 限定写路径(与 skip-permissions 叠加),详见 ADR-0006;
> ⑦ D5 引导链接入治理控制台(dashboard CTA + 顶栏 stale 横幅 → #/govern)。
> **裁决记录(2026-08-02,M7d 开工前用户拍板)**:
> ⑧ **P2-2 加固组合确认**:A 为主(--allowedTools/permissions.deny 把 agent 写路径
> 限定在 KB 内,工具层强制)+ C 兜底(git KB 时跑后 git status 比对)+ B 顺手
> (提示词写"只许写 KB 内")。**落地修订(2026-08-03,八轮 spike 实证)**:
> skip-permissions 与路径规则互斥,裁决④的姿态据此改为 **acceptEdits +
> 生成式 allow-list**(Bash(node repo/**\)、只读 git 前缀、Read(repo/**\));
> 详见 spike-p2-2.zh-CN.md 与 ADR-0006;
> ⑨ **H2 确认**:wiki 人工编辑保存即降级 candidate + review_note 重审;细项——
> a) 候选页同规则(编辑不触发额外状态变化,只记日志);b) 任何状态的页都可编辑
> (规则统一);c) 原文留底:git KB 靠 git,非 git KB 复用 G6 快照;
> ⑩ **H3 走甲**:溯源字段(source_ref/sources)UI 只读,人工编辑永不动血缘;
> 编辑造成的内容/溯源漂移交给后续 agent 治理轮发现修复;漂移若成真实痛点再升级。
> **交付记录(2026-08-03):M7d 完成,既定里程碑(M7a-d)全部交付**——P2-2 加固
> (姿态修订为 acceptEdits + 生成式 allow-list,八轮 spike)+ H wiki 编辑(契约
> §1 白名单⑤,降级重审 + portal 日志动作治理侧同口径)+ J7 页面历史(git log
> --follow / 快照降级)。
> **终审修复轮(2026-08-03,第四轮外部评审)**:H4/H5 以轻形态落地——raw 页面按
> 来源显示修改路径(local:同名文件重传 inbox 重新采集;外部源:引导去源系统);
> 编辑乐观锁(内容 hash + 409 冲突卡);检索消失提示;review_note 保留前值;
> J7 懒加载;图谱"边可能滞后"说明。**index.md 可编辑性审回 by-design**:写门禁
> 排除 index.md 是设计(它每次治理运行被 rebuildIndex 重新生成,人工微调会被
> 重建抹掉;若需要,是手工段落/模板的独立设计,留作 backlog 候选)。
> backlog 排序(采纳评审建议):**C5 批量评审(批量批准/拒绝分开讨论)→ K 评测
> (LLM backend registry)→ J9 → B5**。
> **交付记录(2026-08-02):A7 关系图谱完成**——力导向图(≤2k 节点客户端布局,与
> [[引用签]] 视觉统一);顺手项落地:backlinks 全库扫描消除,改走共享边表
> (retrieval outlinks + 候选页 UI 补扫)。backlog 中 A7 条目关闭。
> 每条标注来源:【用户】= 用户明确表达;【推导】= 从现有系统能力/调研推导,待用户确认。

## 已明确的边界(全程有效)

- 本机单人工具:127.0.0.1,按需启动,无用户系统/权限【用户】
- 不要多人共享服务;不要移动端【用户】
- "向他人展示" = 本机演示给人看屏幕,不需要对方自己访问【用户】
- 现有三服务不依赖前端;前端可依赖现有服务【用户】
- 内网离线,依赖越少越好【用户】
- agent 后端必须可插拔:首个实现是 headless Claude,但任何能使用服务 skill /
  具备同等能力的框架后端都应能同等适配【用户】

## 块 A · 只读浏览(一期已圈定)

- A1 wiki 页面渲染浏览(sources/topics 树 + 正文)【用户】
- A2 wikilink 跳转(页面间导航)【用户·阅读场景圈定】
- A3 页面 status 徽标(candidate/approved/…对人可见)【推导,与 viewer 一致】
- A4 index.md 入口 / 结构感导航(门面三要素之一)【用户】
- A5 raw 证据对照(wiki 页 ⇄ raw 原文并排溯源)【用户】
- A6 反链面板【用户·"都要",优先级后排】
- A7 关系图谱(Quartz 式 wikilink 可视化)【用户·"都要",优先级后排】

## 块 B · 手动检索(一期已圈定)

- B1 查询框 + 结构化语法(type:/source:/tag:/after:/before:)【用户】
- B2 结果卡片:标题 + snippet + score + via 徽标(search/link)【推导,kb_search 输出契约】
- B3 点击结果 → 页面#锚点【推导】
- B4 检索质量检视:完整候选空间、路由信息、图扩展了哪些【用户·B类场景圈定】

## 块 C · 评审队列(一期已圈定)

- C1 candidate 列表【用户】
- C2 diff(vs git HEAD)+ raw 证据 pane【推导,viewer 已有】
- C3 approve / reject(乐观锁 409)【推导,statusflip 同一写原语】
- C4 评审后提示 sweep 回补机制【推导】

## 块 D · 门面 / 健康总览(一期已圈定)

- D1 首页 KB 总览:页面计数、来源分布、最近治理动态【用户】
- D2 log.md 时间线(治理历史可读化)【推导·C类场景圈定】
- D3 健康指标:孤儿页、悬空链接、各状态计数【推导·C类场景圈定】
- D4 视觉品质:精致、拿得出手(含暗色模式?)【用户,暗色待确认】

## 块 E · 上传采集(一期已圈定)

- E1 UI 上传文件 → 写 inbox/(用户暂存区,不写 raw/)→ 触发 acquire → 落 raw/local/【用户】
- E2 上传结果反馈(新增/跳过/孤儿报告)【推导,acquire 输出已有】
- E3 inbox 管理(查看/删除待采集文件?)【推导,待确认】

## 块 F · 源拉取控制台

- F1 UI 输入源参数(JQL / CQL / space / issue key)→ spawn acquire(参数覆盖已支持)【用户】
- F2 拉取结果检视(拉到了什么、增量跳过情况)【用户】
- F3 **不做拉取前预览**【用户】——取而代之的是块 G 的事后删除/移动
- F4 认证状态检查(--check 的 UI 化)?【推导,待确认】

## 块 G · raw 管理(治理前)

- G1 开始治理前允许**删除** raw 文档【用户】
- G2 开始治理前允许**移动** raw 文档(沿用 CONTEXT 语义:移动=新身份,旧文档变孤儿)【用户·已确认】
- G3 **不允许修改** raw 内容【用户】
- G4 删除边界:**任意 raw 可删,需确认**;下游治理发现 wiki 页 source_ref 失效 → orphan 由人裁决(与现有 backstop 衔接)【用户】
- G5 **删除影响预览**:删 raw 前展示引用它的 wiki 页(frontmatter 扫 source_ref),不盲删【用户】
- G6 **破坏性操作前快照**:批量删除/移动前自动留可回滚点——机制见"版本管理约束"【用户】

## 块 H · wiki 编辑

- H1 wiki 页面可在 UI 编辑——理由:治理产物不一定正确,人需要修正权【用户】
- H2 合法路径:保存即降级 candidate + review_note,走评审重新批准(不破坏单写者原则与可审计性)【推导的规则,待用户确认】
- H3 wiki 改动后可触发新治理规则,更新 wiki↔raw 的链接(溯源回链)【用户,具体规则待讨论】
- H4 local 来源内容可改——写回 inbox/ 后重新 acquire,不改 raw/【用户】(落地形态:raw 页提示"同名文件重传 inbox 即重新采集",2026-08-03)
- H5 Jira/Confluence 内容只读,编辑引导去源系统【用户】(落地形态:raw 页来源提示文案,2026-08-03)

## 块 I · 治理流程可视化 + agent 执行器

- I1 UI 可跑机械步骤:sweep / plan 四清单 / rebuild-index / approve / reject / merge【推导】
- I2 治理智力步骤(写摘要、主题综合)由 **agent 执行器**完成——接口抽象,
  首个实现 = headless Claude(claude -p 跑 govern skill)【用户】
- I3 执行器接口可插拔:非 Claude 的框架后端可同等接入【用户·硬性要求】
- I4 在 UI 上观察治理过程:**实时流式**(看到 agent 正在干什么,进程流转发)【用户】
- I5 **治理预览(plan-as-preview)**:触发 agent 治理前展示 plan 四清单作为
  "将要发生什么"的确认页(plan 是只读纯脚本,零风险)【用户】
- I6 **作业中心**:每次 spawn 的操作(acquire/治理/reindex)记录状态/耗时/日志尾巴,
  失败不消失在终端里;与 I4 流式配合成为控制台中枢【用户】

## 块 J · 全局能力

- J1 **KB 切换器**:配置多个 KB 路径,UI 内随时切换【用户】
- J2 暗色模式【用户】
- J3 变更自动刷新(KB 被外部改动时 UI 感知,如 fs watch)【用户】
- J4 inbox 管理(查看已有、删除误传)【用户】
- J5 认证检查(acquire --check 的 UI 化)【用户】
- J6 **来源新鲜度面板**:每源上次拉取时间/文档数/滞后程度(采集侧健康总览)【用户】
- J7 **页面历史时间线**:页面演变史(何时被治理改过/人工编辑过)——依赖版本管理,见下【用户】
- J8 **空态引导**:KB 为空或首次使用时引导下一步【用户】→ **已交付(2026-08-03,
  逐条核验补漏)**:dashboard 空 KB 显示三步引导卡(采集→治理→评审);各视图
  空态此前已有(检索无命中建议/队列清空/图谱空提示)
- J9 **搜索结果反馈 → 黄金集闭环**:结果卡片 👍/👎,👎 查询沉淀为评测黄金集候选,
  与块 K 和现有 tests/eval 回归门形成活循环【用户】→ **已交付(2026-08-03)**:
  投票落 .kb/ui/feedback.jsonl(队列内),👎 面板=黄金集候选池(一键重跑),
  策展进 tests/eval 为手动步骤

## 环境事实:内网可用的 LLM 来源(用户 2026-08-02 提供)

1. **Copilot proxy 转发的 GPT** — 直连本地域名即可访问(预计 OpenAI 兼容形态,待验证);
2. **Azure 部署的 GPT** — SPN(Service Principal)认证;
3. **Claude Code 配置的 LLM** — 即 Claude Code 会话/headless 所用的模型。

这三个来源同时是:块 I agent 执行器的候选后端、块 K 评测 judge 的候选模型。
另外注意:若 copilot proxy 暴露 embedding 接口,retrieval 搁置的向量腿(M3 记录:
"deferred until an intranet embedding endpoint exists")可能被解锁——不在本期范围,记录在案。

## 块 K · 评测服务(backlog,调研已完成 → research-eval.zh-CN.md)

- K1 每次搜索可看到本次结果的评测质量——**形态定为异步徽标**(搜索立即渲染,judge
  后台跑,完成浮现;top-5 约 3-6s、3-4k tokens/查询)【用户+调研】→ **已交付
  (2026-08-03)**:top-5 单次调用批量评分,徽标 3 松绿/2 青瓷/1 琥珀/0 枣红,
  tooltip 理由+后端+耗时
- K2 **方案已定方向(待排期)**:自研轻量 judge(Node 直调 LLM,pointwise 0-3 分 + 理由,
  固定 rubric + temp=0)+ Promptfoo 做 CI 黄金集回归——**全程零 Python**;不选 RAGAS
  (依赖重/要 embedding)、Python sidecar 仅作远期备选【调研结论】→ **部分交付
  (2026-08-03)**:自研 judge 已交付(固定 rubric,解析容错);**Promptfoo 不落**
  (npm 依赖重,违反内网离线规则)——CI 回归继续用现有 tests/eval Hit@5=1.000 门
- K3 judge 与块 I agent 执行器**共用同一套 LLM 后端抽象**(三适配器:copilot proxy /
  Azure SPN[msal-node 或纯 fetch]/ claude -p 备用+交叉验证)【推导+调研】→ **首个
  适配器已交付(2026-08-03)**:judge.mjs 注册点(与 executor.mjs 互为镜像,合称
  "LLM backend registry")+ claude 适配器(--disallowedTools 无文件系统);
  copilot/Azure 端点仍待验证,验证后同一点注册
- K4 现有 tests/eval 黄金集(Hit@5=1.000 回归门)同时用作 **judge 准确性的元回归校准**;
  LLM-judge 是补充不是替代【推导+调研】→ **已交付(2026-08-03)**:
  ui/script/judge-calibrate.mjs(零依赖手动跑法;重建 fixture KB,黄金查询逐条
  检索+判分,报告 judge↔golden 一致率与黄金页均分 →
  docs/test-reports/judge-calibration-latest.md)

## 已排除

- 多人共享 / 用户系统 / 权限【用户】
- 移动端【用户】
- 拉取前预览(用块 G 替代)【用户】
- 修改 raw 内容【用户】
- 引入现成知识库产品(调研结论)【调研】

## 版本管理约束(用户 2026-08-02 提出,方案阶段必须回答)

**不能假设 KB 是 git 仓库**(契约写的是约定,不是保证)。受影响的特性:
G6 快照、J7 页面历史、C2 的 diff(viewer 已有无-git 降级先例:baseline=null)。
方案需覆盖:git 可用时充分利用(git log/diff/commit);不可用时——降级策略
(如操作前复制快照到 .kb/snapshots/?)或强制提示("检测到 KB 未纳入版本管理,
建议 git init / 先提交")二选一或组合。log 管理同理。具体机制在架构方案中对比。

## 待讨论清单

1. ~~H2 wiki 编辑的合法路径~~ → 裁决⑨(降级 candidate + 重审,细则已确认)【已清】
2. ~~H3 wiki 改动后回链规则~~ → 裁决⑩(溯源只读,漂移归 agent 治理轮)【已清】
3. ~~多 KB~~ → J1 切换器;~~删除边界~~ → G4;~~治理观察~~ → I4 流式;~~零碎项~~ → J2-J5(全部要)【已清】

## 规模预期(用户 2026-08-02 提供)

单个 wiki 最多**几百到上千篇**,每篇**几百到几万字**。推论:FTS5 检索、关系图谱
(≤2k 节点的客户端力导向布局)、全量反链扫描均无性能压力;图谱可以放心做成亮点。

## 排期记录(用户已指定为"记下来,后续做")

- C5 **批量评审**:需要,非强需求;具体怎么批量需详细讨论【用户】→ **已交付
  (2026-08-03,用户拍板)**:复选框+全选;批量批准直接执行(误批准可编辑降级找回);
  批量拒绝 armed 二次点击+"sweep 后归档"后果文案;/api/review-batch 单作业逐页容错
- B5 **查询历史/保存的查询**:需要,非强需求【用户】→ **已交付(2026-08-03)**:
  localStorage(KB 维度),最近 8 条 + ★ 保存,一键重跑,跨重载持久
- D5 **新鲜度提示**:当有新 raw 或未治理操作导致 wiki 落后时,UI 给出明显提示引导
  用户发起治理(plan 是只读纯脚本,可低成本支撑);治理永远手动触发,不要定时【用户】
