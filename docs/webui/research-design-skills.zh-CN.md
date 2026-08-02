# 前端设计资源调研归档(2026-08-02):AI 辅助 UI 设计的 skill/知识资源

> 调研问题:GitHub 上有哪些开源资源能**辅助 AI(Claude)做出更好的 UI 设计**。
> star 为 2026-08-02 GitHub API 实时值。姊妹篇:research-design.zh-CN.md(可 vendor 的
> CSS/交互库)。

## 结论摘要

- **首选 vendor:anthropics/skills 的 frontend-design**(★165,670)——Anthropic 官方写的
  "设计品味"提示词,单文件零依赖,直击 AI 生成 UI 的模板感(点名规避三个 AI 默认样式),
  两段式流程(先 token 计划→自审是否雷同→再写码)+ UX writing 章节;
- **次选:nextlevelbuilder/ui-ux-pro-max-skill**(★112,452)的规则数据库——192 产品类型
  ×84 风格×98 UX 指南的机器可查知识底座,弥补 frontend-design 只给方法论不给答案的空白;
- 两者互补:一个管"品味流程",一个管"查表答案"。

## 1. 官方/大厂 agent skills

| 资源 | Star | 实质内容 |
|---|---|---|
| anthropics/skills · **frontend-design** | 165,670(仓) | 纯提示词:设计总监角色设定;点名规避三个 AI 烂大街默认样式;两段式流程(4-6 命名 hex+2 字体+ASCII wireframe+1 个 signature 元素→自审→写码);UX writing 章节。~100 行,单文件可 vendor(需保留 LICENSE) |
| 同仓 web-artifacts-builder | 同上 | React+Vite+Tailwind+shadcn 脚手架,**有构建链,不适用**;仅其反 AI slop 规则可摘抄 |
| 同仓 theme-factory / brand-guidelines | 同上 | 10 套预制主题 token / Anthropic 品牌 token,可参考 |
| obra/superpowers | 264,836 | 工程方法论框架;设计相关仅流程性 visual-companion,不引入 |
| JimLiu/baoyu-design | 2,995 | Claude Design 能力打包,高保真 mockup;依赖重,不适用 |

## 2. 社区 design skill(按 star)

| 资源 | Star | 实质 | 离线 |
|---|---|---|---|
| **nextlevelbuilder/ui-ux-pro-max-skill** | 112,452 | 可搜索本地设计规则库:84 风格/192 调色板/74 字体搭配/192 产品类型推理/98 UX 指南/10 级优先级检查表;Python 标准库脚本,数据全在仓内 | ✅ 可只 vendor 数据+search.py |
| plugin87/ux-ui-agent-skills | 480 | 学院派:DTCG 三层 token + 42 组件原子规格 + 138 真实品牌设计系统库 + 对比度/无障碍校验脚本 | ✅ |
| bitjaru/styleseed | 862 | 设计方法引擎(从参考推导设计语法) | ✅ |
| dominikmartn/hue | 779 | 从品牌学习生成设计系统 skill | ✅ |
| joeseesun/qiaomu-design | 430 | 中文作者,反 AI 味规则集 + 58 真实网站设计系统库 | ✅ |
| superdesigndev/superdesign-skill | 378 | 依赖 CLI+云端 login | ❌ |
| **gnurio/refactoring-ui-plugin** | 237 | 《Refactoring UI》方法论 10 个结构化 skill(视觉层级/字体 scale/色阶/间距/阴影/空状态…),critique 清单定位 | ✅ |
| Laith0003/ux-skill | 56 | 确定性引擎(不调 LLM):112 条 UX 定律 JSON、152 条反模式 linter | ✅ |

## 3. 机器可读设计规范

- design-tokens/community-group(DTCG,W3C token 格式,★2,078);
- material-foundation/material-tokens(★284,基本停更但数据可用);
- Apple HIG 无高质量官方机器可读版(最高社区快照 ★324);
- Laws of UX 无官方仓 → Laith0003/ux-skill 的 112 条 UX 定律 JSON 是替代;
- Refactoring UI 社区整理:erikuus/good-ui(★231)/ gnurio 的 skill 化版本(上表)。

## 4. awesome 汇总

| 仓库 | Star | 价值 |
|---|---|---|
| VoltAgent/awesome-claude-design | 3,300 | **68 个现成 DESIGN.md**(token+规则+rationale 一个文件),可直接挑用 |
| alexpate/awesome-design-systems | 25,579 | 真实设计系统索引,不宜直接注入 |
| hesreallyhim/awesome-claude-code | 51,477 | Claude Code 生态总索引 |
| BehiSecc/awesome-claude-skills | 9,868 | skill 汇总 |

## 排除

superdesign(云端 login)、baoyu-design(重 harness)、web-artifacts-builder(构建链)、
awesome-design 系列(荒芜,<100★)。
