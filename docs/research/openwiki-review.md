# OpenWiki 调研纪要(langchain-ai/openwiki,2026-08-03)

> 调研对象:https://github.com/langchain-ai/openwiki(发布于 2026-06,~14k stars,
> TypeScript;"agent 为你写并持续维护 wiki"的 CLI)。方法:读其 README、源码树,
> 以及它**用自身产品为自己生成的 wiki**(仓库内 `openwiki/` 目录,等于官方架构剖析)。
> 落地结果:四项高价值特性已实现为 F1–F4(见本文末"已落地"节)。

## 它是什么

agent 读代码仓库(code 模式)或个人数据源(personal 模式,Notion/Slack/Gmail/X 等
connector),产出并持续维护一套带 frontmatter 的互链 Markdown wiki。与 Weft 同构:
采集 → agent 治理 → 结构化 wiki → 可视化/检索。Weft 在评审队列、judge 校准、反馈
循环、检索评估上更深;OpenWiki 在增量维护的工程化细节上值得抄。

## 核心机制(值得借鉴点)

1. **增量更新元数据**:`openwiki/.last-update.json` 记录 `{gitHead, updatedAt, model,
   status}`;update 只喂 `git log <lastHead>..HEAD --name-status`;`status:"interrupted"`
   的运行不会被 no-op 跳过(强制重试);只改了 wiki 自身或被 ignore 的路径不算有意义变更。
2. **内容快照防抖**:运行前后对 wiki 目录算 SHA-256,只有内容变了才写元数据。
3. **INSTRUCTIONS.md**:用户手写、工具只读从不改写的治理纲要,每次运行注入。
4. **确定性 middleware 收尾**:agent 跑完后由代码做 frontmatter 校验/迁移、目录
   index.md 确定性重建、链接与 Mermaid 校验——LLM 管内容,代码管结构。
5. **降级-自愈**:Mermaid 校验失败就地降级为 text 块 + 注释,下轮 agent 读注释修复。
6. **密钥脱敏诊断层**:错误/日志/流式输出前按真实密钥值 + token 形状(sk-…、Bearer …)脱敏。
7. **open-questions.md**:Active/Answered/Stale 三区的"未决问题"记忆文件,记录源间
   矛盾与知识缺口,Answered 链接证据而非复制答案。
8. **托管标记块**:往 AGENTS.md/CLAUDE.md 注入只改写 `<!-- OPENWIKI:START/END -->` 之间。
9. **配对实验 eval**(evals/deepswe):baseline vs treatment 同任务同种子同模型,LLM
   生成物按内容哈希缓存,重跑零成本。

## 不建议抄

- Visualizer 依赖公共 CDN 加载图表库——内网直接死(Weft 全 vendor 是对的);
- 遥测;完整 OKF 规范对齐;12 家 model provider 抽象(Weft 走 claude.cmd 委派)。

## 已落地(2026-08-03,F1–F4)

| OpenWiki 机制 | Weft 实现 |
|---|---|
| ① 增量元数据 + interrupted | `.kb/govern_runs.jsonl` 两阶段记录,读侧推断;`/api/health` 挂 `lastGovernRun`;dashboard 卡 + govern 页摘要 |
| ② 内容快照防抖 | `wikiHash()` 前后比对 → noop 标记;rebuildIndex 字节相同即跳过 |
| ③ INSTRUCTIONS.md | `<kb>/GOVERNANCE.md`,服务端 `buildGovernPrompt` 注入(8KB 截断),settings deny + prompt + git 边界三层防护,portal 编辑器(409 乐观锁)在治理台 |
| ④ 确定性收尾 | done handler 只读 `plan()` → `postPlan` 挂 job result;govern 页 findings 卡 + queue 页 banner(实时 plan 数据源) |

未落地候选(按价值排):⑥ 密钥脱敏诊断层(处理 PAT 的系统值得有)、
⑦ open-questions 未决问题文件(与评审队列互补)、⑤ 降级-自愈模式泛化、
⑨ 配对实验方法论(回答"有了 KB,agent 到底好多少")、⑧ 托管标记块。
