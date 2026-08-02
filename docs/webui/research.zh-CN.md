# WebUI 前置调研归档(2026-08-01)

> 本文件是**纯调研归档**,不含方案决策。方案设计在功能清单确认后另行进行(见 README.md 流程)。
> 数据:星数为 2026-08-01 GitHub API 实时值;前端库体积为 jsDelivr 实测 min.js(原始/gzip)。

## 0. 一句话结论

不需要也无法引入任何现成知识库产品(全部要求导入自有数据模型 + 重型基础设施);
"markdown 目录 + SQLite FTS5 + 本地按需界面"的路线已被 qmd 等项目验证;
无构建链前端(marked 12.4KB gz 级)完全够用;中文搜索必须留在服务端 FTS5。

## 1. Obsidian 生态("vault 发布为网站")

| 方案 | 形态 | 技术栈/体积 | 内网适配 | 备注 |
|---|---|---|---|---|
| Obsidian Publish | 官方托管 SaaS | $8-10/站/月 | **不可用**:内容须推送至官方服务器 | 内网直接排除 |
| Quartz v4(★12.9k) | SSG | TS + Preact + remark 管线,Node 22+ 构建,node_modules 数百 MB | 中:产物纯静态可离线,但构建链重 | wikilinks/反链/图谱/悬浮预览开箱即用,**交互设计可抄** |
| obsidian-html(★~383) | SSG | Python 单包 | 中高,但引入 Python 工具链与 Node 栈不顺 | 输出含搜索与图谱 |
| obsidian-export(★1.3k) | CLI 转换器(非 WebUI) | Rust 单二进制 | 高 | 只做 Obsidian 语法→CommonMark |
| kiln | SSG | Rust 单二进制,新项目 | 高但成熟度低 | 支持 Canvas/Mermaid |

共性:都在"为另一套内容语法服务"。我们的 wiki/ 是标准 markdown,无 wikilinks/callouts
兼容负担,引入其构建链得不偿失。

## 2. 开源自托管知识库 WebUI

| 项目 | 星数 | 技术栈 | 基础设施 | 只读浏览+搜索适配 |
|---|---|---|---|---|
| AFFiNE | 71.0k | React + BlockSuite + NestJS + Yjs CRDT | PG + Redis + WS | 差:为实时协作编辑设计 |
| Docusaurus | 65.8k | React SSG | 无(静态) | 中:默认搜索是 Algolia(外网),需换 local-search 插件 |
| Memos | 61.9k | Go 单二进制内嵌前端 | SQLite | 差:碎片时间线无 wiki 层级;**单制品交付形态可抄** |
| Joplin Server | 55.8k | Node | PG | 差:同步服务器,非浏览 UI |
| SiYuan | 45.6k | Go(Gin)+ Svelte | 自有块模型 + SQLite | 差:必须用其块编辑器数据模型 |
| Outline | 39.9k | Koa + React + ProseMirror | PG + Redis + S3,BSL 许可证 | 差:核心价值在协作编辑 |
| Trilium(TriliumNext) | 37.2k | Node + SQLite | 单文件 SQLite | 中:自带 server UI,但笔记存 blob 不吃外部 markdown |
| Khoj | 36.1k | Django + pgvector + Next.js | PG + 向量库 | 中:**答案内嵌来源引用卡片**的 UI 模式可抄 |
| Onyx | 31.4k | FastAPI + Next.js | PG + Vespa + Redis | 低:企业 RAG 全家桶;"答案→来源 chunk 链接"可参考 |
| Wiki.js 2.x | 28.7k | Node + Vue2 + GraphQL,markdown-it 管线 | 仅 PG | 中:**接口分层最值得抄**(渲染管线、存储/检索后端抽象) |
| MkDocs Material | 27.2k | Python SSG | 无 | 好:构建期 lunr.js 索引离线可用,SSG 甜区 |
| BookStack | 19.0k(迁 Codeberg) | PHP Laravel + Blade SSR + 极少 JS | MySQL 全文检索 | 较好:**证明 SSR+简单层级+DB 检索十几年长青** |

**没有一家能直接消费 wiki/ 文件目录**;PG/Redis/ES/Vespa 对内网只读场景是净负担。

## 3. LLM Wiki / AI 知识库前端

| 项目 | 星数 | 形态 | 启示 |
|---|---|---|---|
| qmd(tobi) | 28.5k | **无 WebUI,纯 CLI/MCP**;TS + SQLite(FTS5+sqlite-vec)混合检索 | 与我们架构最同构;chunk 级引用溯源(file:line)契约可抄 |
| Khoj | 36.1k | 见上 | 来源引用卡片,为将来 LLM 问答预留 |
| Dify 知识库 | 151.0k(主仓) | LLM 平台子模块 | "chunk 命中测试"调试 UI 思路可参考 |
| Pratiyush/llm-wiki | 353 | Python,会话编译成 wiki | 形态相近,无 UI 可抄 |

前瞻:检索 API 返回 chunk + 路径 + 锚点 + 来源系统,将来加 LLM 问答时 UI 零重构。
**kb_search 现有输出 {page, anchor, heading, score, snippet, title, via} 已满足该契约。**

## 4. 无构建链前端库(实测体积)

| 库 | 原始 | gzip | 说明 |
|---|---|---|---|
| marked(★37.0k) | 39.9 KB | 12.4 KB | 最小最快;输出不消毒,安全需自理 |
| markdown-it(★21.8k) | 124.8 KB | 45.3 KB | CommonMark 全兼容 + 插件生态 |
| htmx(★48.9k) | 51.2 KB | 16.6 KB | SSR 局部刷新 |
| Alpine.js(★31.8k) | 46.3 KB | 16.7 KB | 声明式交互 |
| DOMPurify | ~45 KB | ~20 KB | XSS 消毒 |

- 总前端负载可控制在 ~60KB gz 内,全部 vendor 进仓库,离线无忧。
- **中文检索是"搜索留服务端"的硬理由**:客户端索引(lunr/FlexSearch/Pagefind)对 CJK
  无分词;服务端 FTS5 trigram 已就绪且经评测(Hit@5 = 1.000)。
- 服务端渲染(markdown-it 在 Node 端)+ htmx 是 BookStack 验证过的最低维护形态;
  客户端渲染(marked vendored)则与现有 viewer 的 no-build 模式同源。两条都可行,
  留给方案阶段权衡。

## 5. 值得抄的设计点清单(供头脑风暴取材)

1. Quartz:悬浮预览、右侧反链面板、局部关系图谱;
2. Wiki.js:渲染管线分段(解析→后处理:链接重写/目录注入)、存储/检索后端抽象;
3. Outline:文档树 + 面包屑 + 最近访问;
4. BookStack:纯 SSR + 渐进增强的克制;
5. Memos:单制品交付;
6. qmd/Onyx/Khoj:chunk 级来源溯源卡片;
7. MkDocs Material:构建期搜索索引(SSG 路线时)。

## 主要来源

- GitHub:jackyzha0/quartz、otaleghani/kiln、siyuan-note/siyuan、Requarks/wiki、tobi/qmd、onyx-dot-app/onyx、outline/outline、TriliumNext、joplin、AFFiNE、memos、BookStack、mkdocs-material、docusaurus、khoj、dify、marked、markdown-it、htmx、alpine(星数均为 2026-08-01 API 实测)
- obsidian-html 文档站、lib.rs/crates/obsidian-export、Obsidian 定价页、DeepWiki SiYuan 架构解析、qmd 介绍文(Korben/BrightCoding)
- 库体积:jsDelivr 下载 min.js 实测
