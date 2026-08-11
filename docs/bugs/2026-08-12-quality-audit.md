# 多维度质量审核报告(agent teams,2026-08-12)

> 生成方式:6 个维度 finder 并行 + 每条发现一个对抗性核实者(46 agents)。
> 去重后 40 条,核实确认 35 条 confirmed / 3 条 plausible(2 条 refuted 已丢弃)。
> 标注 **[已修]** 的为 2026-08-12 修复批次(见 DEVLOG 同日条目);其余为待办 backlog。

## HIGH(5 条)

### [已修] govern.js 白屏事故同类缺口未闭合:UI node 单测仍不解析 public/ 下任何 JS

- 位置: `ui/test/ui.test.mjs:202` · 维度: 测试与文档 · 判定: confirmed
- 问题: 事故 7e6106d(govern.js 字符串里 '\n' 被写成字面换行 → 浏览器解析失败整页白屏)的 hotfix 只修了实例,没加任何回归护栏。已核验:ui/test 17 个测试文件中唯一被 node 真正 import 的 public 资产是 public/lib/sources.mjs(sources-resolve.test.mjs:14);ui.test.mjs:202-215 对 public/*.js 只做 innerHTML 文本扫描,从不解析;app.js + 12 个 views/*.js 的语法错误在全部 100 个 node 单测下不可见(我实测 node --check 可解析这些 ESM 文件,加护栏成本极低)。触发场景:任何视图/app.js 再混入同类转义/引号错误,文档化的回归(node --test test/)全绿,用户开页面即白屏——与昨天事故完全同路径。
- 核实: 核心事实全部核验通过。(1) 事故实锤:7e6106d(当前 HEAD)确为 govern.js '\n' 字面换行致白屏的 hotfix,commit message 自认 "node 单测不解析 public/ 漏网",且 --stat 显示只改了 ui/public/views/govern.js,未加任何测试;7e6106d..HEAD 范围内 ui/test/ 零提交。(2) 缺口实锤:grep 全 ui/test/,唯一被 node import 的 public 资产是 test/sources-resolve.test.mjs:14 的 ../public/lib/sources.mjs;ui.test.mjs:202-215 的 "frontend red line" 测试确为 fs.readFileSync 文本扫描(查 innerHTML),不解析 JS;test 中两处 execFileSync 均为 git 操作,无 node --check/语法校验;ui 无 jsdom 类依赖。(3) 护栏可行性实锤:ui/package.json 有 "type":"module",实测 node --check 对 public/app.js 及全部 views/*.js 解析通过,加护栏成本确极低。(4) 触发路径成立:文档化回归(CLAUDE.md)是 cd ui && node --test test/(无依赖);Playwright e2e(test:e2e)虽能兜住白屏,但需装浏览器、不在文档化默认回归内,与发现中 "文档化的回归全绿、用户开页白屏" 的描述一致。非文档明示的刻意设计——hotfix commit 自身将其定性为 "漏网"。两处次要计数偏差不影响实质:ui/test 为 16 个 .test.mjs(非 17),views/ 为 11 个 .js(非 12;另有 settings.html);且未解析面还包括 lib/ 下 api/diff/icons/md/palette/render.js,缺口比发现所述更大。严重度 high 略可商榷(PW e2e 作为 opt-in 存在兜底),但作为 "已发生同类事故仍未闭合的回归护栏缺口" 定性准确。

### [已修] manual-test-guide 整体围绕已删除的三个 Claude Code skill,README 仍指向它

- 位置: `docs/manual-test-guide.zh-CN.md:26` · 维度: 测试与文档 · 判定: confirmed
- 问题: 技能形态已在 ADR-0012 P3-C9(commit 68c4f18)全删:install.cmd/sh 不再链接 skills、acquisition|governance|retrieval/skills/ 目录不存在。但该指南仍以技能为骨架:§0 检查项『重启 Claude Code 后三个技能可用(kb-acquire/kb-govern/kb-search)』(line 26)永远失败;§1 整节(15 分钟技能对话流,line 37-52)要求触发三个已删技能并以各自 SKILL.md 的『报告/红线』节为通过标准;§3 line 84 引用 SKILL 提示、§4 line 88 要求『观察 kb-search 的行为』。另 line 4 自动化规模声明『node --test tests/(39 项:20+19)』与现实(2026-08-11 DEVLOG:e2e+eval 94)严重不符,术语『topic 页』也是 ADR-0009 之前的叫法(现为 syntheses/entities/concepts)。触发场景:README.md:79 把该指南作为人工测试入口链接出去,任何按指南做验收的人第一节就卡死。
- 核实: 所有子论断经代码/文档核实成立。(1) 技能确已删除:acquisition/、governance/、retrieval/ 下均无 skills/ 目录(仅剩 scripts/,governance 另有 viewer/);install.cmd 与 install.sh 均含注释 "ADR-0012: the three Claude Code skills were retired with the claude CLI",不再链接 ~/.claude/skills;DEVLOG ADR-0012 Phase 3 收官条明确记录三个 SKILL.md 删除。(2) 指南 D:\claude\knowledge-extension\docs\manual-test-guide.zh-CN.md 仍以技能为骨架:line 26 检查项『重启 Claude Code 后三个技能可用(kb-acquire / kb-govern / kb-search)』在现架构下永远失败;§1(line 35-52)整节要求触发三个已删技能,通过标准(line 52)引用已删除的各 SKILL.md『报告/红线』节;line 84『SKILL 有提示』、line 88『观察 kb-search 的行为』同病。(3) line 4 自动化规模声明『node --test tests/(39 项:20+19)』双重过时:路径本身已变(CLAUDE.md 现为 node --test tests/e2e/ tests/eval/),规模亦不符——DEVLOG 2026-08-11 记录 e2e+eval 94,tests/e2e/ 现有 5 个测试文件(含新增的 chat-distill、govern-run)。(4) 术语『topic 页』(line 56/66/74/77/92)是 ADR-0009 之前的叫法,现为 syntheses/entities/concepts(仅 apply-topic 作为 legacy alias 尚存,但页面类型术语已迁)。(5) 触发路径成立:README.md:79 将该指南作为唯一人工测试入口链接。并非文档明示的刻意设计——DEVLOG 声称 ADR-0012 P3-C10 文档全量同步(CLAUDE.md/CONTEXT.md/README/installation/guide),此指南明显是漏网之鱼,无任何文档说明保留其技能形态是有意的。

### [已修] el(tag, null, …) 抛 TypeError:空 KB 与 >2000 节点两条路径都渲染成莫名其妙的报错

- 位置: `ui/public/views/graph.js:396` · 维度: 门户前端 · 判定: confirmed
- 问题: lib/render.js 的 el(tag, attrs = {}, …) 默认值只在 attrs 为 undefined 时生效;graph.js 显式传 null(第 396 行 el('button', null, …)、第 397 行 el('p', null, …)、第 436 行 el('p', null, …))会进 Object.entries(null) 抛 TypeError。触发场景一:全新 KB(无任何 wiki 页面,连 index.md 都没有)打开图谱页,第 434-436 行的空态提示构建即抛错,被 432 行 try/catch 兜住后用户看到的是 'Cannot convert undefined or null to object' 而非友好的空态引导。触发场景二:节点数超过 MAX_AUTO(2000)时,第 394-399 行的守卫提示卡构建抛错,同样变成错误 pre,守卫完全失效。修复:三处 null 改为 {}(或在 render.js 里对 null 容错)。
- 核实: Verified against actual code. ui/public/lib/render.js:28 defines el(tag, attrs = {}, ...children); the default parameter only applies when attrs is undefined, so an explicit null reaches Object.entries(null) at line 30 and throws TypeError "Cannot convert undefined or null to object". graph.js has exactly three such call sites: line 396 el('button', null, '仍然渲染') and line 397 el('p', null, …) inside the raw.nodes.length > MAX_AUTO (2000) guard (line 394), and line 436 el('p', null, …) in the empty-state hint (lines 434-437). Both failure scenarios check out: (1) For a fresh KB, ui/lib/graph.mjs buildGraph (line 30) only adds index.md if it exists (fs.existsSync guard, line 37) and walks empty wiki subdirs, so raw.nodes.length === 0 is reachable; load() succeeds, then line 436 throws, caught by the try/catch at lines 432-440, rendering <pre class="error">Cannot convert undefined or null to object</pre> instead of the friendly empty-state guidance. (2) With >2000 nodes, line 396 throws inside load(), same catch swallows it into an error pre, so the guard card and its opt-in button never render — the guard is fully defeated. The claimed error message matches V8's exact wording for Object.entries(null). No documentation (CLAUDE.md/CONTEXT.md/contract.md) sanctions this; CLAUDE.md principle 4 explicitly requires clear error/empty states. Fix as suggested: change the three nulls to {} or make el() tolerate null.

### [已修] agent CLI 用 ensure_ascii=False 打印 CJK JSON 到 locale 编码的 stdout(实测 gbk),门户 spawn 链路均未设 PYTHONIOENCODING

- 位置: `agent/weft_agent/__main__.py:95` · 维度: agent(Python) · 判定: confirmed
- 问题: __main__.py 收尾 print(json.dumps(..., ensure_ascii=False))(95 行流式任务、102 行非流式)依赖 stdout 编码。实测 agent/.venv Python 3.11.9 的 sys.stdout.encoding == 'gbk',而包内无任何 sys.stdout.reconfigure(encoding='utf-8')。e2e 知道自己有这个坑(tests/e2e/chat-distill.test.mjs:25 显式设 PYTHONIOENCODING 并注释说明),但门户三条 spawn 链路——ui/lib/executor.mjs:76(govern-run)、ui/lib/judge.mjs:29(complete)、ui/lib/distill.mjs:86(distill-chat 经 jobrunner env=process.env)——都不设该变量。触发场景:(a) 输出含 GBK 收不下的字符(emoji、生僻字、部分全角符号)时,任务已全部做完、output 文件已写好,却在最后一次 print 抛 UnicodeEncodeError → exit 1 → 门户把整个 govern-run/distill 判为失败(executor.mjs:134 报 'govern-run 失败');(b) GBK 可编码的 CJK(如 govern-run report 里的中文 doc_error)以 GBK 字节流出,Node 侧按 utf-8 解码成乱码进 done 文本/作业日志。govern-run 处理 143 篇中文文档时 doc-error 几乎必含中文。修复点应在 agent CLI 入口 reconfigure stdout,而不是要求每个调用方设环境变量。
- 核实: 发现属实，全部要素经代码阅读+实证验证：

1. 代码事实确认。agent/weft_agent/__main__.py:95(流式)与 102(非流式)以 ensure_ascii=False print 最终 JSON 摘要；整个 agent 包内 grep 无任何 sys.stdout.reconfigure / PYTHONIOENCODING 处理。实测 agent/.venv Python 3.11.9 在管道下 sys.stdout.encoding == 'gbk'。

2. 门户三条链路均不设 PYTHONIOENCODING。ui/lib/agentcli.mjs 的 agentTaskSpawn 不带 env;executor.mjs:76-78(govern-run)spawn 无 env 项；judge.mjs:29-31(complete)同；distill.mjs:86-87 经 jobs.mjs:172 spawnJob 的 env: process.env。全仓 PYTHONIOENCODING 仅出现在 tests/e2e/chat-distill.test.mjs:25(带注释承认 GBK 坑)与 DEVLOG.md:29——项目已知此坑但只修了 e2e，门户路径裸奔。UI 测试全走 WEFT_AGENT_STUB(node stub)，该 bug 对测试套件不可见。

3. 两种故障模式均实证复现：(a) print 含 emoji 的 JSON → UnicodeEncodeError → exit 1(govern-run 时 writer.end() 已执行、NDJSON 完整、治理全部做完，executor.mjs:134 却报 'govern-run 失败';distill-chat 时 output 文件已在 101 行写好，102 行 print 抛错 → spawnJob 见 exit 1 抛错，整理作业误判失败——聊天转录含 emoji 极常见);(b) 实测 '治理完成' 以 GBK 字节 d6ce c0ed cdea b3c9 流出，Node 侧 executor.mjs:81 `stdout += c` 按 utf-8 解码 → U+FFFD 乱码。govern_run.py:45 report 含 doc_errors(带原始文件名/错误消息),143 篇中文文档的 KB 下中文必入最终 print,done 文本/作业日志乱码近乎必然(JSON 本身仍可 parse，故 exit 0 时仅显示层损坏)。

4. 影响度校准：judge.mjs:42 对 exit 1 有容错(output 文件有文本即 resolve)且不读 stdout,judge 链实际影响甚微；硬失败需非 GBK 字符(emoji/生僻字)触发，乱码路径则为纯外观损坏。故 high 定级偏高、medium-high 更准，但机制、暴露面、触发链全部成立。无任何文档将此记为刻意设计——相反 CLAUDE.md 把同类问题(反向:Python 读服务 CLI 输出须 encoding='utf-8')记为 'P1-C5 bug',DEVLOG 也视此为坑。修复点判断(应在 agent CLI 入口 reconfigure stdout 而非要求每个调用方设环境变量)亦正确。

### [已裁决] 门户直写 .kb/config/(models.json + prompts/),违反契约 §1 写权限矩阵(portal=read)

> **裁决(2026-08-12,用户)**:门户可修改 config——settings 页就是 per-KB 模型/prompt 配置的人工编辑路径。契约 §1 写权限矩阵已修订(portal 列改为 read + write models.json + prompts/)。发现本身(契约与代码不一致)以修契约方式闭合。

- 位置: `ui/routes/api-settings.mjs:102` · 维度: 契约一致性 · 判定: confirmed
- 问题: 契约 §1 写权限矩阵 `.kb/config/` 行给 UI portal 的权限是 **read**(写权限只给 LLM/agent 列,且限定 `prompts/` via `init-prompts` only);但门户设置 API 直接 `fs.writeFileSync` 写 `.kb/config/models.json`(还附带 models.json.bak)和 `.kb/config/prompts/<name>.md`,绕开 init-config/init-prompts 任务。这是冻结契约与代码的直接冲突,且无 ADR/amendment 记录此次放行。触发场景:任何操作员在门户 Settings 页保存模型配置或编辑 prompt,即产生一次契约矩阵未授权的写入;按契约 §7 纪律,要么补 amendment(门户可写 .kb/config/),要么收敛代码。
- 核实: CONFIRMED. 冻结契约 schema/contract.md §1 写权限矩阵（第 61 行）明确：`.kb/config/` 仅 LLM/agent 列可写（且 `prompts/` 仅限 via `init-prompts`),UI portal 列为 **read**；门户白名单 ①–⑥（第 73–95 行）穷尽列举可写路径且声明 "the whitelist is a fixed set in code, never user-extensible… Everything else is read-only"，不含 `.kb/config/`。而 ui/routes/api-settings.mjs 第 102 行 `fs.writeFileSync` 直写 `.kb/config/models.json`（第 101 行附带 .bak)，第 115 行直写 `.kb/config/prompts/<name>.md`，两条 POST 路由均为门户进程直写，绕开 agent 的 init-config/init-prompts 任务，也未走契约要求的 per-KB serial write queue。git 历史显示该直写由 a47150a(2026-08-06 Settings page redo）引入，该提交仅改 ui/ 下文件，未同步 contract.md/CONTEXT.md/任何 ADR——违反契约 §7 变更纪律（frozen contract，改动须 amendment + 文档同步）。ADR-0009 仅称 `.kb/config/` 为 "user-edited, seeded by llm/"，不构成对门户写权限的放行；现有文档（installation.md、guide 5.4、DEVLOG）描述的 Settings 页能力均经由 agent 任务（check/init-config/init-prompts)，未授权直写。触发场景如实：任何操作员在门户 Settings 页保存模型配置或编辑 prompt 即产生契约矩阵未授权写入。按契约纪律应补 amendment 或收敛代码，发现成立。

## MEDIUM(15 条)

### README/installation/guide 三处测试计数与 ADR-0013 后现实漂移(实测 UI=100 vs 文档 96)

- 位置: `README.md:66` · 维度: 测试与文档 · 判定: confirmed
- 问题: 三处文档的测试计数停留在 ADR-0013(chat 蒸馏,2026-08-11)之前:README.md:66-72、installation.md:326-331、guide.zh-CN.md:350-355 均写 acq 75 / pytest 70 / UI 96 / e2e+eval 91;现实(DEVLOG 2026-08-11 条 + 我本地重跑 UI 套件实测 # tests 100 / # pass 100)为 acq 80 / pytest 74 / UI 100 / e2e+eval 94。guide.zh-CN.md:412 自检单『六个测试套件全绿』同样滞后。触发场景:读者跑完套件得到 100 而文档写 96,无法判断是多跑了还是环境错了。
- 核实: 发现属实,实测证据确凿。文档侧:README.md:66-72 写 acq 75 / gov 83 / ret 46 / pytest 70 / UI 96 / e2e+eval 91;docs/installation.md:326-331 与 docs/guide.zh-CN.md:350-355 同样写 75/83/46/70/96/91。实测(本机刚跑):acquisition npm test → # tests 80 / # pass 80;agent pytest → 74 passed;ui node --test → # tests 100 / # pass 100;根目录 node --test tests/e2e/ tests/eval/ → # tests 95, pass 94, skipped 1(即 DEVLOG 所述 opt-in live eval 旧例跳过)。docs/DEVLOG.md:27-28 的 ADR-0013(2026-08-11,即今日)收官条明确记录新计数 acq 80 · pytest 74 · UI 100 · e2e+eval 94,证明 ADR-0013 落地时更新了 DEVLOG 却漏同步三处文档,gov 83/ret 46 未变故未漂移。这不是刻意设计——CLAUDE.md 的 docs discipline 要求文档同步,且 DEVLOG 自身记了新值,纯属疏漏。severity medium 合理:纯文档漂移,不影响代码,但读者跑套件得 100 而文档写 96 确实会产生『多跑了还是环境错了』的困惑。附带核对:guide.zh-CN.md:412 自检单写『六个测试套件全绿』——README.md:61 称 seven suites(五个服务套件 + UI + 跨服务层),guide 按 6 条命令行计 6 个,未含具体数字故不随计数漂移,但该措辞与 README 的 seven suites 表述不一致,属同一处轻微滞后,不改变主结论。涉及文件(绝对路径):D:\claude\knowledge-extension\README.md(L66-72)、D:\claude\knowledge-extension\docs\installation.md(L326-331)、D:\claude\knowledge-extension\docs\guide.zh-CN.md(L350-355, L412)、对照依据 D:\claude\knowledge-extension\docs\DEVLOG.md(L27-28)。

### Playwright 套件(唯一执行 public/*.js 的门禁)在所有文档的测试命令中缺席

- 位置: `docs/installation.md:320` · 维度: 测试与文档 · 判定: confirmed
- 问题: ui/e2e/(flows.spec.mjs PW-01..06 + open-portal 15 例 + chat-input 5 例)是唯一真正加载 public/*.js 的测试层,test-catalog.md §E 把它定为 L1/L2 CI 门禁,但它不出现在任何文档化测试命令里:README.md Tests 节、CLAUDE.md Commands、installation.md §9(line 320-332)、guide.zh-CN.md §11(line 345-355)全部只列 6 条 node/pytest 命令;仅 ui/package.json 的 test:e2e 脚本知道它存在。触发场景:贡献者按文档跑『全量回归』永远跑不到 Playwright——这正是 68c4f18 把 govern.js 破坏带进 main 的机制,昨天事故后仍未把该层写进文档。
- 核实: Every load-bearing element of the finding verified against the repo:

1. ui/e2e/ exists with flows.spec.mjs (PW-01..06), open-portal.spec.mjs, chat-input.spec.mjs, plus prepare.mjs/teardown.mjs; ui/package.json has `"test:e2e": "node e2e/prepare.mjs && playwright test"` and devDependency @playwright/test — the only scripted entry point.

2. docs/plans/test-catalog.md line 62: `## E. Playwright 真实 UI 流程(L1/L2,CI)— ui/e2e/flows.spec.mjs` — explicitly designated an L1/L2 CI gate.

3. Absence from all documented test commands verified: D:/claude/knowledge-extension/README.md (Tests section, line 72 lists only `node --test tests/e2e/ tests/eval/`), CLAUDE.md Commands (lines 64-69, six suites), docs/installation.md §9 lines 324-332 (six commands: acq 75 / gov 83 / ret 46 / pytest 70 / ui 96 / e2e+eval 91 — no Playwright), docs/guide.zh-CN.md §11 lines 348-355 (same six). A repo-wide grep for "playwright" in *.md hits only docs/DEVLOG.md, docs/plans/* (historical plan docs), docs/webui/README.md (spike record), and node_modules — never a runbook/commands doc.

4. The incident-mechanism claim is corroborated by the repo's own hotfix commit 7e6106d: "UI hotfix: govern.js defaultPrompt 的 '\n' 转义被写成字面换行 → 浏览器解析失败整页白屏(68c4f18 混入,node 单测不解析 public/ 漏网)" — the commit message itself attributes the escape to 68c4f18 slipping through because node unit tests never parse public/*.js, which is exactly the gap the finding describes. The documented "full regression" (e2e+eval 90 etc.) would never have caught it.

5. Not deliberate design: no doc states Playwright is intentionally excluded; test-catalog.md §E's L1/L2 CI designation contradicts the omission, and the hotfix commit itself treats the coverage gap as the root cause of the regression.

Minor unverified details (exact case counts 6+15+5 vs DEVLOG's "Playwright 21/21") don't affect the finding. The docs/test-commands gap and its real-world consequence are fully confirmed.

### governance/viewer/public/app.js 零执行覆盖:同 govern.js 盲区且无浏览器套件兜底

- 位置: `governance/viewer/test/viewer.test.mjs:144` · 维度: 测试与文档 · 判定: confirmed
- 问题: viewer 的 13KB 前端 app.js 在全仓库没有任何解析或执行覆盖:governance/viewer/test/viewer.test.mjs:144-151 仅通过 HTTP 把 /app.js 取回断言字节内容/前缀,从不执行;viewer 没有 Playwright 层(ui/e2e 只覆盖 8322 门户,没有任何 spec 访问 8321 viewer)。比 ui/public 更盲区——门户至少有 Playwright 兜底,viewer 连兜底都没有。触发场景:viewer app.js 引入语法错误或运行时引用错误,gov 83 全绿,评审者打开 8321 白屏。
- 核实: 发现全部事实点经代码核实成立：(1) D:\claude\knowledge-extension\governance\viewer\test\viewer.test.mjs:144-156 的 static-serving 测试仅通过 HTTP 取回 /app.js,断言 status 200 与 content-type javascript(甚至比发现所述更弱——连字节内容/前缀都未断言),从不解析或执行。(2) 全仓库 grep app.js 无任何测试 import/node --check/vm 执行 governance\viewer\public\app.js(实测 13249 字节,与"13KB"吻合)。(3) ui\e2e\ 的 Playwright 套件(chat-input/flows/open-portal.spec.mjs)只起 8422/8424 门户,ui/ 内无任何 8321 viewer 引用,viewer 确实没有浏览器层兜底;而门户 ui/public 的 JS 至少经 Playwright 真实浏览器执行覆盖,对比成立。(4) governance\scripts\package.json 的 test 脚本只跑 test/ 与 ../viewer/test/,无语法检查环节。(5) 查 CONTEXT.md/CLAUDE.md 无任何"viewer 前端刻意不测"的明示设计,不属文档化刻意行为。触发场景真实:viewer app.js 引入语法/运行时错误,gov 83 全绿,8321 打开白屏。属测试盲区(medium 定级合理),证据确凿,判 confirmed。

### [已修] 聊天记录 100 条截断方向反了:slice(0,100) 保留最旧,新消息永久丢

- 位置: `ui/public/views/chat.js:16` · 维度: 门户前端 · 判定: confirmed
- 问题: store.write 用 JSON.stringify(arr.slice(0, 100)) 保留数组前 100 条,但消息是 messages.push 追加在尾部(send 第 177 行、ask 第 193 行)。一旦某 KB 的历史达到 100 条(50 轮问答),之后每条新消息都在 index ≥100 处被 slice 掉,刷新页面后最近的对话全部消失,而最旧的对话永远留着。对照 search.js 的同类写法:[q, ...cur] 头部插入 + slice(0,30) 才是保留最新——chat 是同一 idiom 的方向性误用。修复:slice(-100)。
- 核实: 代码逐行核实，发现属实。D:\claude\knowledge-extension\ui\public\views\chat.js 第 16 行 store.write 用 `arr.slice(0, 100)` 持久化（保留头部/最旧 100 条）；而消息追加方向为尾部 push——send() 第 177 行 `messages.push({role:'user',...})`、ask() 第 193 行 `messages.push(assistantMsg)`，随后 saveHistory()(178、243 行）落盘。全文件无任何对 messages 的尾部裁剪（唯一的重置是清空按钮 messages=[])。因此某 KB 历史达到 100 条后，每条新消息在 save 时都位于 index≥100 被 slice 丢弃，刷新页面 store.read 只读回最旧 100 条，最新对话永久丢失——机制确凿。对照 search.js 第 112-114 行 recordQuery:`[q, ...cur]` 头部插入 + store.write slice(0,30)，同一 localStorage store idiom 但方向相反，证实 chat 是方向性误用而非刻意设计；CLAUDE.md/CONTEXT.md 无任何关于聊天记录截断方向的文档化约定。影响范围：仅影响 localStorage 持久化（会话内内存数组仍完整，用户当页可见新消息），刷新后才暴露，medium 定级合理。修复建议 slice(-100) 正确。

### [已修] 图谱导航树停留在 ADR-0009 之前的 topics/sources 两类,entities/concepts/syntheses 页面不可见且被误标为来源页

- 位置: `ui/public/views/graph.js:60` · 维度: 门户前端 · 判定: confirmed
- 问题: renderTree(第 60-61 行)只分组 wiki/topics/ 和 wiki/sources/;ADR-0009 后 topics/ 已迁移消失,服务端 buildGraph(ui/lib/graph.mjs:41)产出的是 sources/entities/concepts/syntheses 四类。结果:导航树的「主题 Topics」组永远为空,entities/concepts/syntheses 页面在树中完全不出现(只剩 sources)。同一漂移在第 258 行 isTopic = path.startsWith('wiki/topics/') 和第 300 行 tooltip 的『主题页/来源页』二分:所有 syntheses 节点被画成空心来源页样式、tooltip 显示『来源页』,图例里的『主题页 ●』永不匹配任何节点。graph.js 最后改动停在 ADR-0007 时代(f119045/83b588a),未被 ADR-0009 波及——这是真正的内容漂移,不是刻意重复。
- 核实: 所有事实性断言逐条核实成立，且确属 ADR-0009 未波及的内容漂移，非刻意设计。

代码证据：
1. ui/public/views/graph.js:59-62 — renderTree 的 groups 只过滤 `wiki/topics/` 和 `wiki/sources/` 两类。而服务端 ui/lib/graph.mjs:41 只遍历 `['sources','entities','concepts','syntheses']` 建节点，schema/contract.md §3 的目录结构中 `wiki/topics/` 已不存在（只有 sources/entities/concepts/syntheses 四类页面 + index.md）。因此「主题 Topics」组永远为空并被 `if (!list.length) continue` 跳过；entities/concepts/syntheses 页面在导航树中完全不出现（既不属于 topics 也不属于 sources 过滤条件），树里只剩 sources。treeNodes = raw.nodes 含全部四类，但过滤条件把它们全部丢弃。
2. graph.js:258 — `isTopic = n.path.startsWith('wiki/topics/')` 对现有任何节点恒为 false，所有 syntheses/entities/concepts 节点落入 else 分支被画成空心来源页样式（line 267-268）。
3. graph.js:300 — tooltip 二分 `n.path.startsWith('wiki/topics/') ? '主题页' : '来源页'`,syntheses 等全部显示「来源页」。
4. graph.js:95 — 图例「主题页 ●」永不匹配任何节点。
5. graph.js:47-50 注释自称「Topics/Sources groups mirror contract.md's structure 1:1」也已过时。

历史证据：graph.js 最后改动为 f119045(ADR-0007 实现）,`git merge-base --is-ancestor` 证实其先于 ADR-0009 Phase 6 收官合并 9e8e341;ADR-0009 系列提交（含 85f9940 「topics/ migrated away」）未触碰该文件。

非刻意设计：CLAUDE.md 中明示的刻意重复仅限 frontmatter.mjs 多份拷贝；contract.md/CONTEXT.md 无任何「图谱视图只展示 sources」的设计声明。节点数据本身带有 frontmatter `type` 字段（graph.mjs:47)，说明修复路径现成，漂移纯属遗漏。

影响属实但有限：语义图画布上这些节点仍可渲染/点击导航（只是样式与 tooltip 误标），页面也可经其他视图到达；导航树缺失三类页面入口 + 图例/tooltip 误导属真实用户可见缺陷，medium 定级合理。

### 队列内 sync git(execFileSync 无超时)冻结整个门户事件循环,与仓库已修复的同类问题不一致

- 位置: `ui/lib/acquire.mjs:129` · 维度: 门户后端 · 判定: confirmed
- 问题: snapshot()(acquire.mjs:129-133)在每次 wiki 编辑保存(edit.mjs:51)、kbfile 保存(kbfile.mjs:33)、raw 删除/移动时用 execFileSync 跑 git add+commit,无 timeout;govern.mjs 的 gitPorcelain/gitHead(55-65)同样是 sync,且在 govern-run 的 async done 回调里被直接调用(govern.mjs:199、261)。Node 单线程:git 慢/卡(大仓库 status、pre-commit hook、Windows Defender 扫描)期间整个门户事件循环冻结——所有 SSE、health 轮询、其他请求全部停顿;git 真卡死则无超时永久挂起。仓库自己在 serve.mjs:48-50 和 govern.mjs:19-21 注释里把这列为一类已修 bug(commit 路径改成了 execFileP),但 snapshot 和 porcelain/head 这些同等热度的路径漏改了。触发:git 仓库型 KB 上任意一次编辑/删除保存,恰逢 git 慢。
- 核实: 所有代码事实经逐一读码核实成立：(1) ui/lib/acquire.mjs:129-132 snapshot() 用 execFileSync 执行 git add+commit，无 timeout;(2) 调用点确认：edit.mjs:51、kbfile.mjs:33、acquire.mjs:88(rawDeleteJob)、acquire.mjs:109(rawMoveJob)，均在 jobs.mjs 的 per-KB 串行队列内 await 执行——async 包装不改变 execFileSync 同步阻塞整个 Node 事件循环的事实，门户 SSE/health/其他请求全部停顿;(3) govern.mjs:55-65 的 gitPorcelain/gitHead 同为 execFileSync，且在 govern-run 的 async done 回调中被直接调用(govern.mjs:199、261)。关键佐证：仓库自己在 serve.mjs:48-50("a 5s blocking execFileSync inside the request handler would stall every other request on the event loop, review 2026-08-04")和 govern.mjs:19-21(N3 review-fix)把"门户事件循环上的 sync git"明确定性为已修 bug 类，commitGovernRun(govern.mjs:100-112)已改 execFileP 并注释 "Async — a sync git here would stall the portal's event loop";CLAUDE.md 设计原则 3 也明示 "hot server paths avoid blocking the event loop (async git...)"。snapshot 与 porcelain/head 属同类热路径却漏改，且无任何注释表明是刻意设计——非文档化决策。无 timeout 意味着 git 真卡(pre-commit hook 网络操作、Windows Defender/锁竞争)时门户永久冻结，连 job cancel 都无法进入事件循环。缓解因素：本机单用户 localhost 工具、小 KB 上 git 通常 <200ms，常态仅短暂卡顿，永久挂死需外部条件——故 medium 定级合理，不影响 confirmed 判定。

### 运行中作业的 cancel 是空操作:除 govern-run 外 spawnJob 从不设置 job.kill

- 位置: `ui/lib/jobs.mjs:101` · 维度: 门户后端 · 判定: confirmed
- 问题: cancel() 对 running 作业只做 job.cancelled = true 然后调用 job.kill?.()——但 job.kill 全仓库只有 govern.mjs:190 的 govern-run 设置过;spawnJob(jobs.mjs:169-188)从不把子进程的 kill 句柄挂到 job 上。后果:对 running 的 pull/upload/detect/distill 作业 POST /api/job-cancel 返回 200 且 UI 显示 cancelled,但 acquire/agent 子进程照常跑完并继续写 raw/(cancel 唯一需要防的'长作业劫持串行队列'场景——M7c P3 注释——根本没解决:一个卡死的 acquire jira 子进程会把该 KB 的串行队列顶死,操作员除了重启门户无计可施)。触发:对任何 running 的非 govern-run 作业调 /api/job-cancel。
- 核实: 核心机制经代码逐行核实，属实：

1. ui/lib/jobs.mjs:101-105 — cancel() 对 running 作业仅 `job.cancelled = true; job.kill?.()`,job.kill 不存在时静默空操作，仍返回 200。
2. spawnJob(jobs.mjs:169-188）全文确认：创建 child 后只挂 stdout/stderr/close 监听，从不把 kill 句柄赋给 job。修复本是一行（`job.kill = () => child.kill()`),govern.mjs:190 正是这么做的（`job.kill = run.kill`)，说明 spawnJob 路径是遗漏而非刻意设计。
3. 全仓库 grep 确认 job.kill 仅 govern.mjs:190 一处赋值（executor.mjs:138 的 kill 是 startRun 返回值，经 govern.mjs 才挂到 job 上）。
4. 受影响作业真实存在且暴露在同一 /api/job-cancel(serve.mjs:701-706 对 type 无限制）:pullJob(acquire.mjs:61，最多 500 页的长拉取）、uploadJob(acquire.mjs:42)、distillJob(distill.mjs:86,agent distill-chat 长运行）、llmJobSpec(jobrunner.mjs:30)。UI 作业中心有取消按钮（public/views/acquire.js:278)。
5. 与文档意图相悖：DEVLOG.md:840-842 M7c P3 明写"作业取消全管道（queued 跳过 / running 调 kill……)——长 agent 运行不再能堵死串行队列",jobs.mjs:92-93 注释同旨。非 govern-run 的 running 作业不满足该承诺。

对严重度叙事的校准（不改变缺陷成立）：发现称"卡死子进程把队列顶死、除重启无计可施"略有夸大——acquisition 连接器每次请求有 30s AbortSignal.timeout(jira.mjs:34/119,confluence.mjs:29)，挂起的单请求会超时失败，子进程退出后 enqueue 链（jobs.mjs:69-71）会将其置为 cancelled 并放行后续作业，队列非永久死锁；且 cancel 返回的 job.status 仍是 'running'（非立即显示 cancelled)。但真实影响成立：一次正常的大拉取（数百页×多请求）或长时间 distill-chat agent 运行期间，cancel 完全无效，串行队列被合法长作业占据直至其自然结束——这正是 M7c P3 承诺解决却未覆盖的场景。判 confirmed,medium 合理（偏中低）。

### govern-run 的 checkpoint 续跑在唯一生产驱动(门户)下不可达

- 位置: `agent/weft_agent/tasks/govern_run.py:26` · 维度: agent(Python) · 判定: confirmed
- 问题: ADR-0012 的卖点之一是"崩溃后按同一 thread_id 从断点续跑"(govern_run.py:26-29 的 resume 分支),但门户侧 ui/lib/executor.mjs:72 每次启动生成随机 run_id(portal-<hex>)且从不传 resume:true——崩溃的 portal 运行永远从 sweep 重新开始,150 篇文档的全部 LLM 调用成本重付一遍(apply-source 幂等所以结果不错,纯粹是钱和时间);崩溃线程的 checkpoint 也因 run_id 不再复用而永久留在 .kb/agent/checkpoints.json(_compact 只压单线程历史,不清死线程)。repo 内除 e2e 外没有任何调用方传 resume。触发场景:门户跑的 govern-run 中途崩溃/被 kill 后再次点击运行。
- 核实: 所有核心事实均经代码验证为真：(1) govern_run.py:26-29 的 resume 分支要求 input.resume===true 且复用同 thread_id;(2) 唯一生产驱动 ui/lib/executor.mjs:71-72 每次生成随机 portal-<hex> run_id 且从不传 resume，全库 grep 确认无任何生产调用方传 resume:true（唯一触达 resume 的是 agent/tests/test_govern_graph.py:85 直接驱动 Python 图 API 的 pytest；发现称"除 e2e 外"略有出入——e2e 也只传 run_id 不传 resume——但不影响实质）;(3) checkpoints.py 的 _compact 保留所有 thread 的最新 checkpoint,delete_thread 仅在成功路径调用，崩溃的随机 thread_id 运行永久残留在 .kb/agent/checkpoints.json;(4) ADR-0012 明确把"每节点 checkpoint、断点续跑"列为设计点，无任何文档说明门户刻意不 resume，故非明示的刻意设计。影响面如发现自己所述：结果不错（apply-source 幂等），纯粹重付 LLM 成本与时间，加死 checkpoint 缓慢堆积；且严格说 resume 并非绝对不可达——崩溃的 run_id 出现在门户 init 事件文本中，用户可手工 CLI 带 resume:true 续跑，但门户 UI 无入口、需要手工构造输入文件。综合：能力在 CLI/图层存在且被测试，但在唯一生产路径下实际不可达，属真实的中等（偏低）严重度缺口。

### deep-research 的"多轮"检索循环永远不会超过 1 轮,且 rounds 字段谎报

- 位置: `agent/weft_agent/research.py:163` · 维度: agent(Python) · 判定: confirmed
- 问题: run_research_loop 每轮用同一个 question 调 search_pages(research.py:165),查询从不改写;FTS 检索是确定性的,第 2 轮 hits 与第 1 轮完全相同,而 read_top(默认 3)≤ hits_per_round(默认 5),第 1 轮已把 hits[:read_top] 全部记入 seen,第 2 轮 to_read 必为空 → break。即 maxRounds/hitsPerRound 参数中 maxRounds 是死参数,'multi-round' 名不副实。同时 research.py:187 返回 {"rounds": max_rounds}、tasks/deep_research.py:33 也回报 opts.maxRounds,而非实际执行的轮数(恒为 ≤1),调用方/门户看到的轮数是编造的。触发场景:任何 deep-research 调用;想要真正多轮深挖时永远只得到单轮 top-3 阅读。
- 核实: Verified against D:\claude\knowledge-extension\agent\weft_agent\research.py and tasks\deep_research.py. (1) Single-round guarantee confirmed: the loop at research.py:163-184 calls search_pages(kb_root, question, limit=hits_per_round) with the identical unchanged query every round (line 165); FTS5 search via kb_search.mjs is deterministic, so round 2's hits equal round 1's. seen is populated with every page in hits[:read_top] during round 1 (line 175, added regardless of read success), so in round 2 to_read = [h for h in hits[:read_top] if h["page"] not in seen] is necessarily empty → break at line 172. The same holds if hits < read_top (all hits read in round 1) and if hits is empty (break at line 168, zero rounds). No query refinement, no follow-up generation, no pagination offset exists anywhere in the loop, so >1 round is unreachable in practice; maxRounds>1 and the hits_per_round-vs-read_top headroom are dead configuration. The docstring "Multi-round research loop" (line 150) is aspirational, not descriptive. (2) rounds misreporting confirmed: research.py:187 returns {"rounds": max_rounds} (the configured cap, never the executed count, which the loop does not even track) and tasks\deep_research.py:33 likewise returns {"rounds": opts.get("maxRounds") or 3} — so a run that executed 0 or 1 rounds reports 3. No doc (CLAUDE.md/CONTEXT.md/contract) sanctions this as deliberate; the function is documented as multi-round. Impact check: ui/**.mjs has no consumer of the rounds field (grep found nothing), and the synthesis still proceeds over the top-3 read pages, so the practical harm is a misleading CLI result field plus a nominally-multi-round feature that never iterates — consistent with the medium severity claimed. Both sub-claims (dead multi-round loop, fabricated rounds count) are textually evident in the code.

### applySourcePage/applyNonSourcePage 每次调用全量重读 raw/ 全部文件，治理运行磁盘 IO 变 O(N×语料)

- 位置: `governance/scripts/lib/govern.mjs:332` · 维度: Node 服务 · 判定: confirmed
- 问题: findApprovedDuplicateRaw（332-346 行）为查一个 hash 遍历 raw/ 并 readDoc 读每个文件全文；applyNonSourcePage 的指纹新鲜度校验（534 行 fingerprintOf(currentRawHashes(kbRoot))，101-109 行同样读全文）每次 apply 也全量扫 raw/。agent 治理运行是 per-document 调 apply-source / apply-entity / apply-concept / apply-synthesis 的：N 个待治理文档 × 每次全量读 raw 语料 = O(N×|raw|) 磁盘 IO。1000 篇 raw、平均 20KB 的 KB，一轮 200 次 apply ≈ 4GB 重复读盘。dedup 比对只需 frontmatter 的 content_hash（detect.mjs 的 readHead 16KB 头读已是现成的省 IO 模式），指纹也可缓存或只 hash frontmatter 块。
- 核实: 代码逐行核实，发现属实：

1. findApprovedDuplicateRaw(governance/scripts/lib/govern.mjs:332-346)确实 walk 整个 raw/ 目录并对每个文件 readDoc(134-136 行 = fs.readFileSync 全文 + parseFrontmatter)，而比对只需要 frontmatter 的 content_hash。applySourcePage 在 369-370 行 `!force && fields.content_hash` 时无条件调用它——acquisition 规范化产出的 raw 都带 content_hash，即每次 apply-source 必触发全量扫读。

2. applyNonSourcePage(entity/concept/synthesis 共用)534 行 `fingerprintOf(currentRawHashes(kbRoot))` 做 conflicts 侧信道新鲜度校验；currentRawHashes(101-109 行)同样 walk raw/ 并 readFileSync 全文(有 content_hash 时仅取之，但仍整文件读入)。

3. 调用模式坐实 O(N×|raw|):agent/weft_agent/govern_graph.py 的 process_doc_node 对 queue 里每个文档各 spawn 一次 `govern.mjs apply-source` 子进程(111-115 行),synthesize_node 每个 cluster spawn 一次 apply-synthesis(180-186 行)。每次 apply 都是全新 node 进程，进程内缓存无从谈起；N 个待治理文档 → N 次全量 raw 语料读盘。1000 篇 × 20KB × 200 次 apply ≈ 4GB 重复 IO 的估算量级正确。

4. 提到的更省模式确实存在：acquisition/scripts/lib/detect.mjs:67-69 `HEAD_BYTES = 16 * 1024` 的 readHead 头读(仅取 frontmatter)。它位于 acquisition 而非 governance，但仓库的纪律就是刻意复制 frontmatter.mjs 等模式，不构成反证。新鲜度校验本身(fail-closed 防运行中 raw 变更)是刻意设计，但"读全文 vs 只读头部/frontmatter 块"是实现细节，无任何文档(CLAUDE.md/CONTEXT.md/contract)将其声明为有意为之。

5. 严重度 medium 合理：非正确性 bug，治理是 launch-on-demand 批路径，但 CLAUDE.md 设计原则 3 明确把 "file walking" 列为性能锚点，且随 KB 规模线性恶化的二次方 IO 与该原则直接冲突。

### 纯字段过滤查询（无 free terms）把整张 chunks 表全量读入内存再过滤

- 位置: `retrieval/scripts/lib/query.mjs:110` · 维度: Node 服务 · 判定: confirmed
- 问题: 无自由词时 candidate 先装全部 chunks 的 id（110 行），随后 116-120 行用 json_each 把候选 chunk 整行（含完整 text）分批捞进内存，到 123 行才按 allowedDocs 过滤。一次 `type:source` 或纯 `after:` 过滤 = 每次请求把整个 chunks 表（全部页面正文切片）读进 JS 堆。2026-08-04 review 刚把 LIKE 路径改成把 allowedDocs 下推 SQL（87-88 行注释明说『加载整张 chunks 表到 JS』是要消灭的回退），但 no-terms 路径漏掉了同一修法——纯字段过滤恰是 agent 构造结构化查询的常态（type:/source:/after: 组合），这是检索热路径上实打实的 O(全库) 内存/IO 回退。修法相同：SELECT id FROM chunks WHERE doc_path IN (json_each(allowedDocs))。
- 核实: Confirmed by direct code read of D:\claude\knowledge-extension\retrieval\scripts\lib\query.mjs. For a pure field-filter query (no free terms), line 110 loads ALL chunk ids via `SELECT id FROM chunks`; lines 116-120 then fetch full rows (`SELECT *`, including the complete text column) for every one of those ids via json_each — before `limit` is ever applied (the limit break is at line 137, after the full fetch/map/sort at 121-124); only line 123 filters by allowedDocs. So `type:source` or a bare `after:` query reads the entire chunks table (all approved-page body slices) into the JS heap and discards most of it. The in-file precedent confirms this is an oversight, not design: lines 87-88 carry a 2026-08-04 review comment stating that loading the WHOLE chunks table into JS was the eliminated fallback, and lines 89-92 pushed the allowed-docs filter down into SQL for the LIKE leg — the no-terms path simply missed the same fix. The proposed fix (`SELECT id FROM chunks WHERE doc_path IN (json_each(allowedDocs))` or adding the doc_path predicate to the batched fetch at line 118) matches the established pattern. Hot-path relevance is real: search() is called in-process by the UI portal (ui/lib/search.mjs:18, ui/serve.mjs:304-306) and parseQuery explicitly supports pure type:/source:/tag:/after:/before: queries, so the portal search box can trigger it. One exaggeration in the finding: the Python agent's research.py passes natural-language questions rather than structured field filters, so "agent 构造结构化查询的常态" overstates that specific trigger — but the portal/CLI user path suffices, and medium severity is fair given current KB scale (hundreds of pages, tens of MB) versus the O(corpus) regression on a documented hot path. No doc (CLAUDE.md/contract/CONTEXT) blesses this behavior; the line-108 comment describes semantics, not a deliberate perf tradeoff.

### findGroups 对 exact-dup 组成员一律跳过 similar 检查，近似版本文档可整体逃逸冲突检测

- 位置: `governance/scripts/lib/similarity.mjs:217` · 维度: Node 服务 · 判定: confirmed
- 问题: dupIndexes 收集的是所有处于任意 duplicate 组的文档下标，第 217 行跳过的是『任一端在 dup 组里』的所有候选对，而非仅跳过 dup 对本身。触发场景：KB 里 A≡B（content_hash 相同，入 duplicate 组），C 是同一文档的近似改版（标题同族、正文相似度过阈值）。对 (A,C) 因 A∈dupIndexes 被跳过，对 (B,C) 因 B∈dupIndexes 也被跳过 —— C 的唯一预筛伙伴都在 dup 组里时，similar 组永远不会生成。冲突检测在此静默 miss（fail-open），与 ADR-0008『similar version 一律强制 candidate（fail-closed）』的设计相反。正确做法是只跳过两端同属一个 dup 组的对。
- 核实: 代码与复现双重确认。D:\claude\knowledge-extension\governance\scripts\lib\similarity.mjs 第 202-217 行：dupIndexes 收集所有处于任意 duplicate 组的文档下标，第 217 行 `if (dupIndexes.has(ai) || dupIndexes.has(bi)) continue; // already classified` 跳过的是任一端在 dup 组里的所有候选对，而非仅 dup 对本身。注释 "already classified" 对跨组对 (A,C) 是错的——该对从未被分类。实测复现：A≡B(content_hash 相同）+ C 为近似改版（pay-timeout-v2.md，正文相似度超阈值）,findGroups 只产出 duplicate 组 [A,B],(A,C)/(B,C) 的 similar 组均未生成，C 完全逃逸冲突检测。测试（test/similarity.test.mjs 第 78-86 行）只断言 "duplicate wins over similar" 针对的是 hash 相等的那一对本身，没有三元场景覆盖，故该回归无测试拦截。ADR-0008 明确要求 similar version 一律强制 candidate(fail-closed，源于 bug 0001 的教训——两个版本文件被静默融合批准），此处 fail-open 静默 miss 与设计相反。无任何文档（CLAUDE.md/CONTEXT.md/ADR-0008/contract.md）明示 "dup 组成员豁免 similar 检查" 为刻意设计。正确修法如发现所述：只跳过两端同属一个 dup 组的对（即 ai、bi 都在同一 hash 组），跨组对仍应走 body-similarity 确认。影响属实但触发需要"精确重复对 + 第三篇近似改版"同存，medium 定级合理。

### agent 写 `.kb/agent/` 与 `.kb/bodies/`,但契约 §1 的 .kb/ 目录树与写权限矩阵均未包含/授权这两处

- 位置: `agent/weft_agent/checkpoints.py:127` · 维度: 契约一致性 · 判定: confirmed
- 问题: agent 服务运行时写 `.kb/agent/checkpoints.json`(checkpoints.py:127-128)和 `.kb/bodies/` 页面正文暂存(governcli.py:20-24,CLAUDE.md gotchas 也记载了 .kb/bodies/ 约定),但契约 §1 的 .kb/ 目录树只枚举了 index.sqlite/search_state.json/candidates/acquire_runs.jsonl/acquire/govern_runs.jsonl/govern/config/ui 九项,既无 `.kb/agent/` 也无 `.kb/bodies/`;写权限矩阵中 LLM/agent 列除 `.kb/config/prompts`(init-prompts)外没有任何 .kb/ 写授权。即 agent 的全部 scratch 写在冻结契约里无位可归 —— ADR-0012 落地时未对契约做 increment-compatible 增补(加目录属于契约 §7 允许的增量演进,但需要补登记)。
- 核实: 事实层面完全成立。(1) agent/weft_agent/checkpoints.py:125-129 `checkpoint_saver()` 在 `<kb>/.kb/agent/checkpoints.json` 建目录并写 LangGraph checkpoint(每次 put/put_writes/delete_thread 都 _dump)。(2) agent/weft_agent/governcli.py:18-25 `write_body_file()` 写 `<kb>/.kb/bodies/<name>` 页面正文暂存。(3) schema/contract.md §1 的 .kb/ 目录树确实只枚举九项(index.sqlite、search_state.json、candidates/、acquire_runs.jsonl、acquire/、govern_runs.jsonl、govern/、config/、ui/),无 .kb/agent/ 与 .kb/bodies/;§1 写权限矩阵中 LLM 列(agent 服务在 ADR-0012 前身的名字)对 .kb/ 的唯一写授权是 `.kb/config/` 的 `prompts/ via init-prompts`,其余全 read。因此 agent 的全部运行时 scratch 写在冻结契约里无条目可归。(4) 契约 §7 明确规定契约演进为 increment-compatible only、加目录属允许的增量,但 ADR-0012 落地(多次提交,含文档收官 af5ac39)确实未对 contract.md 做相应增补 — 且契约自身要求"修改需同步 CONTEXT.md + ADR"。一个旁证:governcli.py 的 docstring 声称 "contract: .kb/bodies/",而契约里并无此条目,说明作者以为已登记。CLAUDE.md gotchas 记载了 .kb/bodies/ 约定,但这只是项目工作约定,不是三方冻结契约。影响评估:严重度偏 medium 下沿——无功能危害(.kb/ 全目录 gitignored、可重建,且没有其他服务写这两处,单一写者原则未实际被破坏),但这是"frozen contract 是唯一事实源"纪律的一次真实疏漏,契约读者/新服务实现者无法从契约得知这两个目录的存在与归属。判定 confirmed。

### contract.md 头部/写权限矩阵/actor 词表仍称第四服务为 'llm',与 ADR-0012 的 agent 重命名及契约内 ADR-0013 修订段自相矛盾

- 位置: `schema/contract.md:3` · 维度: 契约一致性 · 判定: confirmed
- 问题: 契约仍声明四方为 acquisition/governance/retrieval/**llm**(第 3-4 行),写权限矩阵列名仍为 `LLM`(第 54 行),log.md actor 词表仍含 `llm`(第 393-394 行);但 ADR-0012 已把该服务重命名为 agent(`agent/`,Python),且契约自己的 2026-08-11 ADR-0013 修订段落(第 140 行)已经写 'the agent service's distillation task' —— 同一份冻结契约内部自我矛盾。CONTEXT.md 同样未同步:第 315/319-320 行仍写 'four services'、'acquisition → governance → retrieval → llm in order'、'the Claude session or a daily job',而 ADR-0012 已退役 Claude session 形态(CONTEXT.md 第 28 行自己也承认了)。后果:任何以 contract.md 为准的新实现会去找一个不存在的 'llm' 服务。
- 核实: 发现所述每一处均与代码/文档现状吻合,且无任何"刻意保留 llm 命名"的文档依据,属于 ADR-0012 重命名后的文档同步遗漏。

证据(contract.md,均已逐行核对):
1. 头部第 3-4 行仍声明 "the four services: acquisition / governance / retrieval / llm"。
2. 写权限矩阵第 54 行列名仍为 `LLM`。
3. 第 344 行写 "LLM auto-decisions carry actor: llm";第 393-394 行 log.md actor 词表为 `govern | review | acquire | portal | llm`,连 `agent` 都不在枚举内。
4. 而同一份契约的 2026-08-11 ADR-0013 修订段(第 140 行)已经写 "the agent service's distillation task" —— 契约内部新旧命名并存,自我矛盾成立。

与运行代码的进一步背离(比发现所述更重):agent 服务实际写盘时传的是 `--actor agent`(agent/weft_agent/govern_graph.py:112、183),与契约第 344 行规定的 `actor: llm` 直接冲突;契约的 actor 词表(393-394 行)既无 `agent` 也不反映现状。

CONTEXT.md 部分同步、部分陈旧:术语表(第 25、35 行)已改为 "five services / Agent service",但第 311 行仍写 "orchestration is the Claude session's or the portal scheduler's responsibility",第 315 行仍写 "the four services",第 319-320 行仍写 "the Claude session or a daily job calls acquisition → governance → retrieval → llm in order" —— 与第 28 行自己承认 "the Claude Code skill form was retired" 矛盾。

非刻意设计的反证排查:ADR-0012(docs/adr/0012-declaude-llm-layer-to-langgraph-agent-service.md)全文未提契约同步;DEVLOG 的 ADR-0012 Phase 3 文档收官条列出的同步清单(CLAUDE.md/CONTEXT.md/README/installation/guide)明确不含 contract.md;契约 §7 自己规定"修改本文件须同步 CONTEXT.md + ADR"。没有任何文档说明"冻结契约刻意保留 llm 命名"。历史变更注记(第 11 行 "added the llm service")属 v1→v2 changelog,保留合理,但头部/矩阵/actor 词表是规范性现行文本,不在此列。

影响评估:这确实是文档不一致,但性质是命名层面的失同步而非契约结构性错误——LLM 列的权限语义与 agent 服务实际行为(.kb/config 写、其余只读)仍一一对应,CLAUDE.md 与 CONTEXT.md 术语表均已正确定义 agent 服务,新实现者不至于真的"找不到服务"。medium 定级合理,事实层面全部成立,判 confirmed。

### applySourcePage 无条件写 status:'approved'，会静默覆盖门户人工编辑产生的待审 candidate 源码页

- 位置: `governance/scripts/lib/govern.mjs:388` · 维度: Node 服务 · 判定: plausible
- 问题: applyNonSourcePage 有 keepCandidate + assertNoUnloggedFlip 双重保护（既保留 candidate 状态、又拒绝吞掉未记录的 review flip），而 applySourcePage 两者都没有：只要 raw 的 source_version 变了（plan 判 stale），它就无条件覆写页面并硬编码 status: 'approved'。触发场景：操作员通过门户手工编辑 wiki/sources/<x>.md（按契约 §1⑤ 被降级为 candidate 并写 portal | candidate:manual 日志，处于待审），此时上游源文档更新，下一次治理运行跑 apply-source —— 人工编辑被静默覆盖、页面从 candidate 直接变 approved，且新日志行 auto:update-source 把 pending-review 标记从审计链上抹掉（sweep 的 lastLogAction 再也看不到 candidate:*）。这违反契约 §4 'approval is a review outcome only' 的候选保护精神，且与非源码页的行为不一致。
- 核实: 机制属实但定性夸大、且大体属文档明示设计。证实部分：governance/scripts/lib/govern.mjs:388 附近 applySourcePage 确实无条件 status:'approved'，无 keepCandidate/assertNoUnloggedFlip（对比同文件 applyNonSourcePage 491-492 行两者齐备）；触发链完整——ui/lib/edit.mjs:25 允许编辑 wiki/sources 页并降级 candidate + 写 portal | candidate:manual 日志，govern.mjs:220 plan 仅凭 source_version 判 stale（pending 项不带页面 status），agent/weft_agent/govern_graph.py process_doc 只读 raw 重新摘要后调 apply-source 覆写，sweep 不动 candidate 页，人工编辑确会被静默丢弃。但：(1) '抹掉审计链'不成立——log.md append-only，candidate:manual 行永久保留，auto:update-source 也是审计记录，flip 是有记录发生的；(2) 契约约明示此不对称：contract.md §3.2 'source-following updates are low-risk automatic operations'、§4 'Takes effect automatically: source page creation/update'，candidate protection 条款明确限定 topic page，governance.md 同样只写 topic 页；(3) §1⑤ 预告 'drift between edited content and provenance is reconciled by later agent governance rounds'。残留实质问题：⑤的 demote 规则为被编辑页创建了 pending-review semantics，而 source 页的待审状态会在无人审阅下被自动消解，契约未正面覆盖此交叉场景，与非源码页行为不一致。影响有限（KB 为 git repo 可恢复；手编 1:1 派生 source 摘要页是边缘用法）。确有其事但影响存疑，判 plausible。

## LOW(18 条)

### installation.md 章节编号断裂:缺 §8、§12 重复

- 位置: `docs/installation.md:320` · 维度: 测试与文档 · 判定: confirmed
- 问题: installation.md 的章节号从 ## 7(line 273)直接跳到 ## 9(line 320,无 §8),且 ## 12 出现两次(Troubleshooting line 353、Uninstalling line 368);对照 installation.zh-CN.md(§1-12 完整无重号)确认是 EN 版编辑漂移。README line 40 指引读者看 §7 恰好未受影响,但任何按章节号交叉引用 §8+ 的读者会错位。
- 核实: Verified by direct inspection. In D:\claude\knowledge-extension\docs\installation.md, the `## ` heading sequence is: 1, 2, 3, 4, 5, 6, 7 (line 273, Smoke test), then 9 (line 320, "Optional: run the test suite") — §8 is skipped; and `## 12.` appears twice: line 353 "Troubleshooting" and line 368 "Uninstalling". The parallel docs\installation.zh-CN.md has a complete, duplicate-free sequence §1–§12 (with "可选：跑测试套件" correctly numbered §8 at line 225), confirming the EN version drifted during an edit rather than this being deliberate design (no note in CLAUDE.md/CONTEXT.md sanctions section renumbering; zh-CN is the intact mirror). Cross-reference impact check: README.md:40 cites §7 (intact), CLAUDE.md:59 cites §3–4 (intact), docs\guide.zh-CN.md:194 cites §6.4 (§6 intact in both versions) — so no in-repo cross-reference currently lands in the broken §8+ range; the harm is limited to future/manual section-number citations, consistent with the low severity assigned.

### README『The three services』残留 — 服务数自相矛盾

- 位置: `README.md:56` · 维度: 测试与文档 · 判定: confirmed
- 问题: README 开头(line 5)正确声明五个服务,但目录结构表后的总结句仍是 ADR-0012 之前的『The three services have zero code dependency on each other』。触发场景:新读者同一段落内读到 five services 和 three services 两个数字,削弱契约文档可信度。
- 核实: Confirmed by direct read of D:\claude\knowledge-extension\README.md. Line 5: "five fully decoupled services"; the repository-layout table (lines 46-50) lists five service dirs (acquisition/, governance/, retrieval/, agent/, ui/); line 61 says "five service suites". Line 56 still says "The three services have **zero code dependency** on each other" — a leftover from before ADR-0012 added agent/ and the UI portal as services. Checked CLAUDE.md, CONTEXT.md, and schema/contract.md context: the decoupling principle is documented without any count; "three services" is not a deliberate term for a subset (the layout table's five rows immediately precede the sentence, so it can't refer to a subset either). The contradiction is real and sits in the repo's front-door doc, but impact is low (cosmetic doc inconsistency; the zero-dependency principle itself is correctly stated). One-word fix: "three" → "five" (or drop the numeral).

### Prompts 编辑器切换文件时无未保存拦截,编辑内容被静默丢弃

- 位置: `ui/public/views/settings.js:340` · 维度: 门户前端 · 判定: confirmed
- 问题: renderPrompts 的 open()(第 340 行)切换 prompt 文件直接 stage.textContent='' 重建编辑器,ta 里未保存的修改无任何确认即丢失——ta 的 input 监听只把 saveNote 置为『未保存』(第 363 行),不构成拦截。同文件 LLM 区有完整的 llmDirty + confirm 守卫(第 38-40 行),prompts 区行为不一致;治理页 GOVERNANCE.md 编辑器也有 409 冲突卡。触发:改了一半 summarize 的 prompt,顺手点开另一个 prompt,回来改动全无。
- 核实: 代码逐条验证属实。ui/public/views/settings.js:341-375 的 open() 切换 prompt 文件时直接 stage.textContent='' 重建编辑器,无任何脏检查/确认;363 行 input 监听仅置 saveNote='未保存',不构成拦截。同文件 38-40 行 LLM 区确有 llmDirty+confirm 守卫(17-18 行注释明示设计意图就是防止静默丢弃),且守卫只挂 llmDirty——prompts 区编辑不仅切文件丢,切 section 也丢(视图 hashchange 重挂载)。对照声明核实无误:govern.js:253-256 GOVERNANCE.md 编辑器注释明示沿用 browse.js 的 optimistic-lock 409 纪律,browse.js:431 有 409 card。无文档(设计原则/注释/ADR)将此声明为刻意设计,反而设计原则 4 与 LLM 区注释意图指向这是遗漏。low 严重度定级合理:仅 UX 一致性缺陷,无数据损坏或安全问题,但触发场景真实(编辑一半切文件,改动不可恢复)。

### 两个图标名不在 ICONS 注册表,静默回退成 fileText 图标

- 位置: `ui/public/views/queue.js:120` · 维度: 门户前端 · 判定: confirmed
- 问题: queue.js:120 icon('alertTriangle', 14) 与 dashboard.js:132 STAT('link2', …) 在 lib/icons.js 注册表中都不存在(注册表是 'link-2' 带连字符,没有 alertTriangle),icon() 的兜底 ICONS.fileText 让冲突组警示条和『悬空链接』统计卡都显示成文件图标,警示语义丢失。属静默退化,无任何报错。
- 核实: 两处事实均经代码核实为真:

1. `ui/public/views/queue.js:120` 确实调用 `icon('alertTriangle', 14)`(冲突组警示条)。通读 `ui/public/lib/icons.js` 完整注册表(基础 ICONS 对象 + M7b Object.assign 追加的 14 个键),全部键为:activity, arrowLeft, bookOpen, check, chevronDown, chevronRight, circleAlert, clock, command, copy, cornerDownLeft, database, externalLink, fileText, fileX, filter, folderGit-2, gitBranch, history, inbox, keyboard, layers, layoutDashboard, library, link-2, listChecks, moon, panelLeftClose, panelLeftOpen, search, sparkles, sun, tag, x, upload, download, trash2, play, folderInput, shieldCheck, network, pencil, thumbsUp, thumbsDown, circleHelp, archiveRestore, messageCircle, settings —— 无 `alertTriangle`(相近的语义图标是 `circleAlert`)。

2. `ui/public/views/dashboard.js:132` 确实调用 `STAT('link2', h.plan.dangling_links, '悬空链接', true)`;STAT(dashboard.js:10-12)直接把名字传给 `icon()`。注册表中该图标键为 `link-2`(带连字符),无 `link2`。

3. `icon()` 的实现(icons.js:4-7)是 `ICONS[name] || ICONS.fileText` —— 未知名静默回退为文件图标,无任何报错或日志。

结论:两处调用都命中兜底,冲突组警示条与「悬空链接」统计卡均渲染成 fileText 文件图标,警示语义确实丢失。属真实存在的低严重度装饰性缺陷(功能不受影响,仅图标语义错误),发现描述与代码完全一致,无文档表明这是刻意设计。修复也简单:queue.js 改用 'circleAlert',dashboard.js 改用 'link-2'。

### 初始标签态不一致:『导航树』高亮但显示的是语义图

- 位置: `ui/public/views/graph.js:27` · 维度: 门户前端 · 判定: confirmed
- 问题: 第 27 行 tabTree 带 class 'active',第 32 行 treePane 却 hidden、graphPane 可见——打开图谱页时『导航树』标签呈选中态,实际展示的是语义图画布。用户想看树必须去点一个看起来已选中的标签。二选一:默认 tabTree 不加 active,或默认展示 treePane。
- 核实: Confirmed. ui/public/views/graph.js:27 gives tabTree ('导航树') class 'active' while line 32 hides treePane (setAttribute('hidden','') via render.js el()) and leaves graphPane visible. style.css:518 gives .graph-tabs button.active a visible highlight (celadon underline + bold), so on first open the '导航树' tab looks selected while the semantic graph canvas is shown — the user must click an apparently-already-selected tab to see the tree. The code itself proves the graph pane is the intended default (line 409 runs fitView on the initial load path when graphPane is visible), so the real mistake is the 'active' class being on the wrong tab; the finding's either/or fix is valid. ADR-0007 does not mandate a default tab, so this is not documented deliberate design. Severity is correctly low: pure initial-state cosmetic/UX inconsistency, no functional breakage.

### [已修] localStorage.setItem 无 try/catch:配额写爆时静默中断 send 流程

- 位置: `ui/public/views/chat.js:16` · 维度: 门户前端 · 判定: confirmed
- 问题: chat.js 的 store.write(第 16 行)与 search.js 的 store.write(第 11 行)都没捕获 QuotaExceededError。chat 每条 assistant 消息带 steps/citations,深研答案很长,100 条历史可达数 MB;写爆时 saveHistory 在 send() 内(第 178 行)同步抛出 → 事件处理器里的 promise 变 unhandled rejection,用户消息已 push 进内存但 renderMessages/ask 不再执行,表现是『发了没反应』且无任何提示。store.read 有 try/catch 而 write 没有,不对称。修复:write 里 try/catch,失败时截断重试或静默降级。
- 核实: 代码事实全部核实：chat.js:16 与 search.js:11 的 store.write 均无 try/catch，而 read（chat.js:15/search.js:10）有，不对称属实。失败路径确凿：chat.js send() 中 saveHistory()(178 行）在 renderMessages()(179 行）与 ask()(182 行）之前同步执行，QuotaExceededError 抛出时用户消息已入内存数组但永不渲染/发送，input 未清空，事件处理器无 catch → unhandled rejection 且零提示，"发了没反应"描述准确。触发条件可信：历史上限 100 条、assistant 消息含 steps/citations/深研长文，单条数十 KB,5MB localStorage 配额可达。非文档明示的刻意设计（CLAUDE.md/contract 无相关约定，read 端防御表明 write 端是遗漏）。影响为 low 级别边缘场景（需配额耗尽，单机 localhost 工具可清站点数据恢复），但一旦发生即静默且稳定复现。修复建议（write 内 try/catch + 截断重试/静默降级）合理。

### executor 的 govern-run 子进程 stdout 缓冲无上限(stderr 有 32KB 上限,stdout 没有)

- 位置: `ui/lib/executor.mjs:81` · 维度: 门户后端 · 判定: confirmed
- 问题: child.stderr 有 32KB 截断(84 行),child.stdout 是裸 `stdout += c` 无上限。govern-run 结束时 stdout 被 JSON.parse 当 summary,若 python 进程异常刷屏(stdout 打印日志/警告),门户内存随运行时长无界增长。与 stderr 的截断纪律明显不对称,属同一函数内的疏漏。触发:govern-run 子进程 stdout 输出失控。
- 核实: Verified in code: ui/lib/executor.mjs line 81 accumulates child stdout via `stdout += c` with no cap, while lines 82-85 cap stderr at 32KB — the asymmetry is real. The accumulated stdout is JSON.parse'd at close (line 129) and used in the failure message (line 134), so it is a semantic summary channel that the buffer treats as unbounded. Cross-checked the agent side: agent/weft_agent/__main__.py docstring (lines 3-5) defines stdout as "prints a JSON summary" with progress going to the NDJSON file and errors to stderr, and grep shows no print/logging/warnings to stdout anywhere in agent/, so in normal operation stdout is a single bounded JSON summary. Unbounded portal memory growth therefore requires the python child to abnormally flood stdout (stray dependency print, future regression) — low probability, matching the finding's own low severity. No documentation (CLAUDE.md/CONTEXT.md/contract.md) presents the missing cap as deliberate design, so it cannot be dismissed as intentional. The defect is verifiably present and the failure scenario is reachable, hence confirmed at the stated low severity.

### validateConfig 声称要求 https,实际 startsWith('http') 放行明文 http 端点

- 位置: `ui/routes/api-settings.mjs:54` · 维度: 门户后端 · 判定: confirmed
- 问题: 校验函数报错信息写 'endpoint must be an https URL',但实际判断是 String(config.endpoint).startsWith('http')——http:// 明文端点照常通过并落盘 models.json。之后 agent 服务会带着 API key(配置里的 env 变量名对应的密钥)向该 http 端点发起 LLM 请求,密钥明文上网段。触发:操作员在设置页手滑把 https 写成 http,门户不拦。
- 核实: Confirmed. ui/routes/api-settings.mjs:54 reads `if (!config.endpoint || !String(config.endpoint).startsWith('http')) return 'endpoint must be an https URL';` — the error message states an https requirement but the check passes any `http://` URL, and POST /api/settings/config then writes it verbatim to .kb/config/models.json (lines 95–103). No test pins https (ui/test/settings.test.mjs only covers rejection cases unrelated to scheme). On the consumer side, agent/weft_agent/client.py build_endpoint (line 53) uses the endpoint as-is and _do (line 142) POSTs with the API key header via httpx, so a cleartext http endpoint would receive the key unencrypted — the claimed leak path is real. The portal's POST is token-gated and the trigger requires operator error, which bounds severity (low, as filed). One mitigating nuance: client.py's docstring explicitly advertises "any OpenAI-compatible endpoint (Kimi, DeepSeek, vLLM, …)" and vLLM-style local servers are commonly http://localhost — so permitting http may be semi-intentional, in which case the defect is at minimum the misleading error message ('endpoint must be an https URL') contradicting the actual check. Either way the finding's factual core — message claims https, code allows http, key transits in cleartext on typo — is verified against the code; no CLAUDE.md/CONTEXT.md/contract.md documentation sanctions the discrepancy. Fix is one line: require startsWith('https://') (optionally exempting localhost) or correct the message.

### /api/raw-asset 以 image/svg+xml 直出 KB 内 SVG,无 CSP/attachment,顶层打开即同源脚本执行

- 位置: `ui/lib/paths.mjs:63` · 维度: 门户后端 · 判定: confirmed
- 问题: normalizeRawAssetRel 白名单含 .svg(paths.mjs:63),serve.mjs:321-322 直接以 image/svg+xml 流式返回,无 Content-Disposition、无 CSP/sandbox。当前前端只经 <img> 加载(md.js:82,脚本不执行),但一旦资产 URL 被顶层打开(中键新标签、复制链接),SVG 内嵌脚本即在门户源执行——同源可读 '/' 拿到注入的每启动 token,随后调用全部写 API;Host/Origin 检查对同源脚本无效。资产内容来自 Confluence 拉取的 Gliffy 附件,属半不可信输入。触发:KB 内含恶意 SVG 资产 + 操作员在新标签页直接打开该资产 URL。修法便宜:对 svg 加 Content-Security-Policy: sandbox 或强制 attachment。
- 核实: 发现属实。代码逐项核实：(1) ui/lib/paths.mjs:63 ASSET_EXT 白名单含 .svg，ASSET_MIME 映射 image/svg+xml；(2) ui/serve.mjs:315-323 /api/raw-asset 以 image/svg+xml 流式直出，无 Content-Disposition、无 CSP/sandbox 头；(3) 前端仅经 <img> 加载（ui/public/lib/md.js:82），正常使用路径不执行脚本，但顶层打开（新标签/复制链接）时 SVG 内嵌脚本在门户源执行——浏览器标准行为；(4) 同源脚本可 fetch('/') 拿到 serve.mjs:729 注入 index.html 的每启动 token（%%UI_TOKEN%% 替换）；(5) ui/lib/auth.mjs 的 checkHost/checkWrite 只校验 loopback Host/Origin + x-ui-token，同源脚本自带合法 Host/Origin，持 token 即通过全部写检查，可调用全部写 API——auth.mjs:34-36 注释自认"读到注入 token 即失守"。攻击链完整：恶意 SVG 经 Confluence Gliffy 附件（半不可信输入）进入 KB → 操作员顶层打开资产 URL → 同源脚本执行 → 偷 token → 任意写。严重度 low 合理：本地单用户工具、需两步触发条件，但非文档明示的刻意设计（paths.mjs 注释只谈扩展名白名单，未提 SVG 脚本风险；CLAUDE.md 原则 4 要求门户"safe"）。修法便宜：svg 响应加 Content-Security-Policy: sandbox 或强制 Content-Disposition: attachment。

### /api/chat 子进程资源失管:stderr 无上限、300s deadline 不杀进程不关响应、stdout 管道无人消费

- 位置: `ui/serve.mjs:660` · 维度: 门户后端 · 判定: confirmed
- 问题: 三处叠加:(a) child.stderr 累加无任何上限(executor.mjs 同类缓冲有 32KB 上限,此处没有);(b) streamNdjson 的 300s deadline(serve.mjs:81-85)到期只是停止 tail——既不 res.end() 也不 child.kill(),若 python 子进程挂死,child+SSE 响应+缓冲无限期存活,只能靠客户端断开(res close 才 kill);(c) spawn 用了 stdio:'pipe' 的 stdout 但从不挂 data 监听(serve.mjs:644-646),一旦 chat 任务哪天向 stdout 打印超过管道缓冲(Windows ~64KB)的内容,子进程写阻塞死锁且无人杀它。触发:agent chat 子进程 hang 或 stderr/stdout 输出失控(模型服务故障、依赖库刷屏)。
- 核实: All three sub-claims verified in code. (a) ui/serve.mjs:659-660 accumulates child.stderr with no cap, while the parallel buffer in ui/lib/executor.mjs:82-84 is capped at 32KB — the inconsistency is real and the accumulated string is only ever used via slice(-2000), so the unbounded growth serves no purpose. (b) streamNdjson's 300s deadline (serve.mjs:81-85) returns silently: no res.end(), no child.kill(), no error event; the child 'close' handler that would end the SSE response only fires when the child exits, so a hung python child with a patient client leaks the process + socket + stderr buffer indefinitely (only client disconnect via res 'close' at serve.mjs:692-695 kills it). (c) stdio:['ignore','pipe','pipe'] (serve.mjs:645) with no stdout listener is factual, but currently latent: agent/weft_agent/__main__.py:94-96 shows chat prints only a one-shot JSON summary to stdout and tasks/chat.py:146 returns just {"level": level} (~hundreds of bytes, far under the ~64KB Windows pipe buffer), so the write-block deadlock needs a future change or a dependency printing to stdout. Impact is genuinely low: triggers require agent-side malfunction (hang/runaway stderr), the portal is localhost with per-startup token and single user, and the normal path is unaffected. Facts conclusive; severity rating (low) accurate.

### 非流式重试把永久性 4xx(认证/配置错误)也重试 4 次,且 200 但 JSON 解析失败同样重试

- 位置: `agent/weft_agent/client.py:129` · 维度: agent(Python) · 判定: confirmed
- 问题: chat_completion 的 except Exception 全捕获重试(client.py:133):_do 对非 200 抛 RuntimeError(含 400 参数错、401/403 认证错、404 部署名错——这些重试永远不会成功),每次调用白白等 1+2+4=7s 并重复打 4 次失败请求后才把真正的错误抛给上层;200 但 res.json() 解析失败(gateway 返回空体/HTML 错误页配 200)也被同样重试。触发场景:models.json 配错 deployment、SPN token 被拒、网关 401 时,check/chat 的报错延迟 7 秒且网关侧多 3 次无效请求。只应重试 429/5xx 与连接层错误。
- 核实: Verified in D:\claude\knowledge-extension\agent\weft_agent\client.py: the non-streaming retry loop (lines 129-137) catches all exceptions (`except Exception`, line 133) and retries 4 total attempts with 1+2+4=7s backoff. `_do` (lines 143-144) raises RuntimeError for any non-200 with no status-code discrimination, so permanent 4xx (400/401/403/404, e.g. wrong deployment in models.json, rejected SPN token, gateway 401) are retried identically to transient 429/5xx, adding 7s latency and 3 futile gateway requests before the real error surfaces. `res.json()` failure on a 200 (empty/HTML gateway body) raises JSONDecodeError, also caught and retried. Streaming path correctly does not retry, matching the finding's scope. Git history shows this is a faithful port of the deleted llm/lib/openai.mjs (same retry-everything loop), and ADR-0009 only documents the retry parameters (1s/2s/4s, 3 retries) — retrying 4xx is not a documented deliberate design decision. Impact is accurately rated low by the finding itself: off hot path, correct error eventually propagates, cost is delay + redundant requests on misconfiguration. All factual claims confirmed.

### parse_args 把缺值的长选项静默当布尔 True,--input-file 缺值时任务拿空输入照跑

- 位置: `agent/weft_agent/__main__.py:44` · 维度: agent(Python) · 判定: confirmed
- 问题: parse_args(44-47 行)在 `--flag` 后跟另一个 `--xxx` 或到末尾时记 True;而 80 行用 isinstance(input_path, str) 判断,--input-file 缺值时被当成'没传',input 静默为 {}。这违反仓库自己的纪律(CLAUDE.md:布尔 flag 必须 fail loudly,--candidate yes 之类不得静默)。触发场景:`python -m weft_agent chat --kb K --output-file o.ndjson --input-file`(顺序写错/漏值)→ chat 以空 question 跑完整个检索+LLM 流程并产出 refusal,而不是 exit 64 报用法错,排查时极误导。
- 核实: 实证复现确认。agent/weft_agent/__main__.py:44-47 的 parse_args 在 `--input-file` 后无值(或跟另一个 `--xxx`)时记为布尔 True;第 80 行 `isinstance(input_path, str)` 于是把它当"未传",input_payload 静默为 {}。实测(用 agent/.venv):`python -m weft_agent chat --kb <scratch> --output-file o.ndjson --input-file` → **exit 0**,stdout 打印成功摘要 `{"refused": true}`,NDJSON 显示空 query 走检索失败→refusal 路径,而不是 exit 64 报用法错。这确实违反 CLAUDE.md 明示的纪律("Boolean flags take no value ... and fail loudly otherwise";agent CLI 三个选项全是带值选项,不存在布尔 flag,bare `--flag` 理应 exit 64)。文档中无任何处说明此 lax 解析是刻意设计,非 documented design。

两点限定(不影响定性,low 定级合理):
1) 发现的触发描述略有夸大:空 question 下 search_smart 报错→零命中,R3 质量门(chat.py:106)直接写固定 refusal,**不会**发 LLM 调用——所以是"静默跑完检索并产出误导性 refusal",而非"跑完整个检索+LLM 流程"。误导性排查问题成立。
2) 实际触发面窄:仓库内调用方(ui/lib/agentcli.mjs 的 agentTaskIO、tests/conftest.py)都以 argv 数组形式 spawn,flag 永远带值,不可能缺值;只有人手敲 CLI 时漏值/顺序写错才触发,属健壮性/DX 缺口而非生产路径 bug。

同类隐患顺带存在:bare `--kb` 会被静默丢弃并回退 KB_PATH 环境变量(resolve 到别的 KB),比 --input-file 更危险,但不在本发现范围内。修复方向:parse_args 对已知带值选项缺值时 usage() exit 64。

### 崩溃后同 run_id 非 resume 重跑会把崩溃run的 results/hooks 累积进新 run(已实测)

- 位置: `agent/weft_agent/tasks/govern_run.py:29` · 维度: agent(Python) · 判定: confirmed
- 问题: govern_run.py:26-29:resume 为假时直接 app.invoke({}, cfg),不检查也不清理该 thread 的既有状态。实测 langgraph 1.2.10:同一 thread_id 用 {} 再次 invoke 会从旧 checkpoint 的状态继续,带 add reducer 的通道(results/doc_errors/hooks)直接叠加(测试复现:results 由 ['r1','r2'] 变 ['r1','r2','r1','r2'])。触发场景:CLI 用户在 run 崩溃后用同一 run_id 重跑但不传 resume(语义上他要的是全新 run)——plan 节点会重置 queue,但崩溃run的 results 残留导致 govern_run.py:36-38 的 created/updated/deduped 计数翻倍,旧 hooks 还会漏进 synthesize_node 的聚类(synthesize 簇按 raw 去重,但来自已失效run的 hook 仍可能把某主题凑过 MIN_CLUSTER_RAWS 门槛或喂进过时页面正文)。修复方向:非 resume 且 thread 存在时先 delete_thread 再 invoke。
- 核实: 代码路径属实且核心机制已实测复现。(1) D:\claude\knowledge-extension\agent\weft_agent\tasks\govern_run.py:26-29:非 resume 时直接 app.invoke({}, cfg),不检查/不清理该 thread 的既有 checkpoint;delete_thread 只在成功跑完后执行(:33),崩溃 run 的 thread 必然残留。(2) 用 agent venv 里的 langgraph 1.2.10 做了最小复现:同 thread_id 崩溃后(next=('b',), 残留 results=['r1'])再用 {} invoke,结果 results=['r1','r1','r2']、hooks=['h1','h1'] —— 与发现中"带 add reducer 的通道叠加"完全一致(新 run 从 START 重跑但从旧 checkpoint 状态出发,queue 等无 reducer 通道被 plan 节点覆盖,而 results/doc_errors/hooks/syntheses/synth_errors 五个 add 通道全部累积)。(3) 后果成立:govern_run.py:36-38 的 created/updated/deduped 从 final["results"] 计数会翻倍;synthesize_node(govern_graph.py:136-141)按 raw 去重只能挡同 raw 重复 hook,挡不住崩溃 run 遗留的异 raw hook —— 确实可能把新 run 里本不够 MIN_CLUSTER_RAWS 的主题凑过门槛、多吃一个 MAX_SYNTH_CLUSTERS 名额、并把不在本次 queue 的 raw 写进 --sources。发现中"喂进过时页面正文"这一点略有夸大——页面正文在合成时从磁盘现读(:163-165),且残留 hook 的 apply-source 在崩溃前已成功,页面是新的;但计数翻倍与聚类污染两个主后果均确凿。非文档明示的刻意设计:docstring(:30-32)只解释了崩溃 run 保留 thread 是为了 resume,未考虑非 resume 重跑场景,测试也只有 crash+resume 用例(agent/tests/test_govern_graph.py:85),无非 resume 重跑覆盖。触发面窄,符合 low 定级:门户侧 executor.mjs:72 每次生成全新 run_id(portal-${id})且从不传 resume,门户路径免疫;仅 CLI 用户崩溃后用同一 run_id(或默认 "govern-run")重跑且不传 resume 时命中。修复方向(delete_thread 后再 invoke,或 checkpointer 换空)正确可行。

### before:<date> 边界日语义与注释相反：当天更新的文档被排除

- 位置: `retrieval/scripts/lib/query.mjs:70` · 维度: Node 服务 · 判定: confirmed
- 问题: eff 在索引时已归一化为 UTC ISO（如 '2026-07-01T00:00:00.000Z'），而 f.value 是调用方给的裸日期 '2026-07-01'；字典序上 '2026-07-01T…' > '2026-07-01'，故 eff <= f.value 对当天所有文档（含午夜整）都不成立。行内注释写 'before includes that day's midnight'，实际行为是 before:<date> 把当天整天排除。agent 用 after:/before: 构造日期区间时边界日文档静默消失（after 侧却是含当天的，区间不对称）。测试只钉了跨日行为（search.test.mjs 147-157），未钉边界日，注释与行为至少错一个。
- 核实: Verified in code and empirically. store.mjs:167-173 toUtc() normalizes all parseable dates (including bare dates) to full UTC ISO with T...Z suffix via d.toISOString(); query.mjs:70 compares eff <= f.value where f.value is the raw user input. Node check: '2026-07-01T00:00:00.000Z' <= '2026-07-01' === false, so before:<date> excludes every doc updated on that UTC day, including exactly midnight — directly contradicting the inline comment at query.mjs:66-67 ('before includes that day's midnight'). The after: side (eff >= f.value) is inclusive of the boundary day, so bare-date ranges [after:X, before:Y] include day X but exclude day Y — asymmetric, as claimed. Test gap confirmed: search.test.mjs:147-157, 171-183, 300-303 all pin previous-day or cross-day behavior only; no test puts a doc's effective date exactly on the filter date. Not documented design: CONTEXT.md §181-187 and DEVLOG document which date is used and UTC normalization but are silent on boundary inclusivity; contract.md doesn't mention after:/before:. The only stated intent is the inline comment, which the code violates — so comment and behavior are indeed inconsistent. One framing caveat: the repo contains no code-pinned agent construction of after:/before: ranges (agent prompts live in the KB), but the eval report (retrieval-eval-latest.md q13 'reconciliation before:2026-07-29') shows bare-date before: is real usage, so the defect bites real callers. Severity low is appropriate: silent one-day edge exclusion, retrieval otherwise functional, one-line fix (normalize date-only f.value for before: to T23:59:59.999Z or correct the comment).

### 降级 in-topic 冲突检查用未归一化的 newSources 做 includes 比较，Windows 反斜杠 --sources 输入漏标 forced-candidate

- 位置: `governance/scripts/lib/govern.mjs:554` · 维度: Node 服务 · 判定: confirmed
- 问题: mergedSources 在第 500 行经 normalizeRawRel 归一化（反斜杠转正斜杠），但 554 行拿未经归一化的 newSources 原始输入与 findGroups 产出的 posix 相对路径 r 做 includes 比较。normalizeRawRel 本身接受 Windows 风格 'raw\jira\X.md'（169-176 行先替换反斜杠），所以这类输入能合法通过校验进入此分支；此时 includes 永不命中，相似版本组不标 flaggedRaws，forced candidate 被静默跳过——恰好发生在 conflicts side-channel 缺失/过期这条本就要求 fail-closed 的降级路径上。agent/CLI 在 Windows 上惯用反斜杠路径时触发。
- 核实: 代码直读验证成立。governance/scripts/lib/govern.mjs:500 只对 mergedSources 做 normalizeRawRel（该函数 169-176 行显式将反斜杠转正斜杠，故 Windows 风格 'raw\jira\X.md' 是合法通过 495-498 行存在性校验的输入）；而 554 行降级路径用未归一化的 newSources 与 findGroups 产出的 posix rel 做 includes 比较，反斜杠输入永不命中，flaggedRaws 不加入、560 行 forcedConflict 为 false,forced candidate 在 conflicts side-channel 缺失/过期这条本应 fail-closed 的降级兜底路径上被静默跳过。CLI 层（govern.mjs:78）只 list() 拆分无归一化，原始输入直达。文档（CLAUDE.md/contract/governance.md）未将此列为刻意设计，属同函数内归一化不一致的真实缺陷。定级 low 合理：触发需同时满足降级路径 + 反斜杠输入 + 新 source 落在 similar 组三个条件。附带：573 行 readDoc 对反斜杠 newSources 在 Linux 上会读失败被 try/catch 吞成空 token 集，是同一遗漏的次要静默退化。

### CLAUDE.md 称契约'frozen three-party',契约自称 'four-party'

- 位置: `CLAUDE.md:19` · 维度: 契约一致性 · 判定: confirmed
- 问题: CLAUDE.md 第 19 行称 contract.md 为 'frozen three-party contract',而 contract.md 第 6 行自称是 'four-party contract'(acquisition/governance/retrieval/llm 四方;viewer/portal 在矩阵中有列但不是缔约服务)。纯文档口径漂移,极易在引用契约时造成混淆。
- 核实: Direct quote evidence: CLAUDE.md:19 calls schema/contract.md the "frozen three-party contract", while contract.md:3-7 self-describes as the contract of "the four services: acquisition / governance / retrieval / llm" and says "Modifying this file = modifying the four-party contract". CONTEXT.md:110 agrees with contract.md ("the single four-party contract"). The "three-party" wording is stale v1 terminology from before contract v2 (frozen 2026-08-05, ADR-0009) added the fourth (llm) service; README.md:16 and docs/installation.md:341 carry the same stale wording. Not deliberate design — contract.md is authoritative per its own §7 change discipline. Pure documentation drift, zero behavioral impact, but it can mislead about how many services the contract binds (and masks the related staleness that contract.md still names "llm" rather than the ADR-0012 "agent" service). Low severity, factually exact.

### CLAUDE.md 称 portal 持有 frontmatter 副本,实际 portal 跨包 re-export governance 代码,与'刻意重复'纪律记载不符

- 位置: `ui/lib/review.mjs:4` · 维度: 契约一致性 · 判定: plausible
- 问题: CLAUDE.md 的 frontmatter 纪律原文为 'the viewer/portal hold more copies',即门户应持有自己的 frontmatter 副本;实际 ui/lib/review.mjs:4-5 直接 `export { ... } from '../../governance/scripts/lib/statusflip.mjs'` 和 frontmatter.mjs —— 这是跨服务代码 import(governance 内部路径硬编码进 ui/),正是设计原则 1('zero code dependency... deliberate duplication instead of hidden coupling')要避免的隐藏耦合。契约说门户翻状态走 'the governance statusflip primitive',共享实现或许有意,但 CLAUDE.md 的陈述因此失实,且 governance/scripts/lib 一旦移动/改名,门户运行时即断。
- 核实: 事实核查结果:发现的事实内核属实,但定性被契约部分削弱。

证实部分:
1. ui/lib/review.mjs:4-5 确为跨包 re-export:`export { flipStatus, normalizeWikiRel, readStatus } from '../../governance/scripts/lib/statusflip.mjs'` 和 `export { parseFrontmatter } from '../../governance/scripts/lib/frontmatter.mjs'` —— ui/ 硬编码了 governance/scripts/lib 内部路径,是真实的跨服务代码 import。
2. CLAUDE.md:145-146 的陈述 'frontmatter.mjs is deliberately duplicated across the services (and the viewer/portal hold more copies)' 与实际不符:全仓只有 3 份 frontmatter.mjs 副本(acquisition/governance/retrieval,glob 确认),viewer 和 portal 均不持有自己的副本 —— viewer(governance/viewer/serve.mjs:19-20)从 ../scripts/lib 导入(viewer 位于 governance 包内,属包内引用,可辩护),portal 则跨包导入。文档记载失实这一点确凿。

削弱/反驳部分:
1. schema/contract.md §1 白名单 ③ 明确写着门户翻状态 'via the governance statusflip primitive' —— 共享 statusflip 实现是冻结契约明示的刻意设计,不是隐藏耦合;statusflip.mjs:11 注释也明说 'Exported for the UI portal's M7d edit path',是有意为之并记录在案的。
2. 无运行时 bug:路径虽脆(governance/scripts/lib 移动会断门户),但 UI 测试套件(96 绿)覆盖该路径,移动时会立即红,风险可控。
3. 真正失实的只是 CLAUDE.md 一句括注;契约本身(statusflip primitive 共享)与代码一致。

综合:doc-vs-code 不一致确凿(CLAUDE.md 括注失实 + ui/ 跨包导入存在),但发现把它定性为违反'刻意重复'纪律这一点被契约 §1 ③ 反驳——共享是契约明示设计。属'确有其事但影响存疑':应修的是 CLAUDE.md 那句括注(或把 parseFrontmatter 的 re-export 一并说明),而非代码。low 严重度定级合理。

### applyNonSourcePage 语义检查扫描不排除被更新页面自身，更新时会把页面自己报进 semantic_check_required

- 位置: `governance/scripts/lib/govern.mjs:577` · 维度: Node 服务 · 判定: plausible
- 问题: 语义检查扫描（570-590 行）遍历 wiki/entities|concepts|syntheses 全部页面与『新增 source 的标题 token』做重叠匹配，但没有排除正在 apply 的这个页面本身（对比 mergePages 853 行有 path.resolve(abs)===path.resolve(fromAbs) 的自排除）。更新已存在的页面时该页就在磁盘上：只要新 source 标题与页面标题/alias 有 ≥0.3 token 重叠（『页面总结同名 source』是常态），semantic_check_required 就把页面自己列进去。后果是治理 agent 被提示对一个页面和它自己的新 source 做强制语义自查——纯噪声信号，每次此类更新白烧一次 LLM semantic-check 调用。
- 核实: Mechanical claim verified and reproduced: governance/scripts/lib/govern.mjs:570-590 scans all of wiki/entities|concepts|syntheses for title-token overlap with new source titles and never excludes the page being applied (unlike mergePages at line 853 which has path.resolve(abs)===path.resolve(fromAbs) self-exclusion). Empirical repro: apply a synthesis, then update it adding a source whose title overlaps the page's own title → output semantic_check_required: ["syntheses/payment-timeout"], the page listing itself. Design intent (docs/plans/0001 §102, ADR-0008) is to surface OTHER pre-existing pages for factual-conflict self-check, so self-inclusion is a genuine defect, not documented deliberate design. However, the stated consequence is wrong: "每次此类更新白烧一次 LLM semantic-check 调用" does not hold post-ADR-0012. Nothing consumes the field to fire LLM calls — agent/weft_agent/govern_graph.py never reads semantic_check_required (its _maybe_candidate runs its own semantic-check against the existing body on every update regardless), and the UI portal doesn't consume it either. Actual impact is a noise entry in the govern CLI JSON output, not a burned LLM call. Real but low-impact defect with overstated consequence → plausible.
