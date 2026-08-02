# 前端设计资源调研归档(2026-08-02):无构建链 / 离线 vendor 场景

> 触发:M7a slice 1 自写 CSS 被用户吐槽"太丑、交互差"。本调研回答:哪些设计资源
> 能**下载单文件/目录进 vendor/ 即离线可用**(不允许 npm build)。
> 数据:star 为 GitHub API 实时值(2026-08-02);体积为 jsDelivr 实测 gzip。

## 结论摘要

**推荐组合 ≈ 60KB gzip:Pico CSS v2(11.7KB)+ Alpine.js(16.7KB)+ hotkeys-js(3.5KB)
+ tippy.js(9.1KB)+ lucide-static 按需 SVG(<20KB)**

Pico 是唯一同时命中全部硬条件的 CSS 框架:classless 默认(marked 渲染的裸 HTML 零改动
即美化)、内置暗色、自带 nav/article 卡片/dialog/dropdown、活跃维护。
明确排除:Tailwind Play CDN(运行时编译+官方非生产定位)、Material Web/Spectrum
(import map 依赖图脆弱)、anime.js v4/motion v12(体积收益不匹配)、Water.css(停更无组件)。

## 1. Classless / 低 class CSS 框架

| 框架 | Star | gzip | 暗色 | 组件 | 判断 |
|---|---|---|---|---|---|
| **Pico CSS v2.1.1** | 16,759 | 11.7KB | 内置(自动+data-theme 手动) | 表格/表单/卡片/nav/modal/dropdown/accordion | **当选**:唯一全条件命中,活跃维护 |
| Water.css | 8,649 | 3.6KB | 自动不可手动 | 无组件 | 2024 停更,排除 |
| MVP.css | 5,129 | 2.7KB | 无 | nav/卡片/表格,无 modal | 无暗色,排除 |
| Sakura | 4,389 | 1.3KB | 另引主题文件 | 无组件 | 极简排版,排除 |
| Milligram | 10,215 | 2.3KB | 无 | 无卡片/modal | 2023 停更,排除 |
| new.css | 4,037 | 1.8KB | 主题变体 | 无 | 2024 停更,排除 |
| Almond.CSS | 1,168 | 4.3KB | 自动 | 少量 | 社区小,排除 |

## 2. CSS 工具库

- Open Props(5,484★,7.7KB gz 全量):纯 design tokens,不含组件,补充用;
- modern-normalize(7,377★,1.3KB)活跃;normalize.css(53,538★)2018 后未实质更新。

## 3. Web Components UI 套件

| 套件 | Star | 离线 vendor | 判断 |
|---|---|---|---|
| Shoelace | 13,851 | autoloader 0.7KB+主题 4.3KB,但 dist/ 全量 9.4MB/5870 文件 | 品质最高;**后续需要复杂 dialog/drawer 时可选**,本期不引 |
| Web Awesome(Shoelace 后继) | ~1.3k | 同构 | 太新,观望 |
| Material Web | 11,142 | 需手写 import map + vendor lit 依赖图 | 工程成本高,排除 |
| Spectrum WC | 1,526 | monorepo 更重 | Adobe 生态,排除 |

## 4. 轻量交互增强库

| 库 | Star | gzip | 用途/判断 |
|---|---|---|---|
| **Alpine.js** | 31,828 | 16.7KB | **当选**:下拉/Tab/折叠/x-transition,声明式契合无构建 |
| htmx | 48,868 | 16.6KB | 可选:服务端直出片段免写 fetch,与 node:http 契合 |
| **tippy.js** | 12,263 | 9.1KB 含 CSS | **当选**:tooltip/悬停预览;停更但稳定 |
| **hotkeys-js** | 7,119 | 3.5KB | **当选**:Ctrl+K 全局搜索,性价比最高 |
| driver.js(nilbuild/) | 26,503 | 8.2KB 含 CSS | 可选:新手引导 |
| SortableJS | 31,158 | 15.0KB | 暂不需要 |
| AOS | 28,065 | 4.7KB | 工具门户价值低,排除 |
| anime.js | 71,683 | v3 7.1KB / v4 29.3KB | Alpine transition 已够,排除 |
| motion | 33,043 | mini ~3.8KB | 同上,排除 |

## 5. Tailwind 离线可行性

Play CDN(v3 138KB / v4 browser 74KB gz)vendor 后离线可用但运行时编译+官方非生产定位;
**预编译单文件**(独立 CLI 一次跑出 purge 后 10-30KB 入库)是生产级答案,不算项目构建链。
但 utility-first 对 marked 渲染产物无能为力(仍需自写 typography),本项目语义化框架更省维护。

## 6. 图标(纯 SVG,离线零门槛)

lucide(23,737★,~1600 个)/**heroicons**(23,712★,320 个)/tabler(21,271★,5900+)。
推荐 **lucide-static 按需取单 SVG**(每个 ~350B,门户用 30-60 个 <20KB)。

## 注意事项

当日 GitHub 匿名 API 限流:mvp.css/holiday.css 取自搜索接口、Web Awesome 取自 shields.io,
精度略低但量级可靠。
