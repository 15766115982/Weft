# KB Portal UI 优化设计计划(2026-08-02)

> 流程:frontend-design skill 两段式——本文 = token 计划 + 布局/交互方案,**用户确认后才写码**。
> 依据:research-design.zh-CN.md(Pico/Alpine/hotkeys/tippy/lucide 组合)+
> research-design-skills.zh-CN.md(frontend-design skill 方法论)。
> 约束不变:无构建 ES modules、vendor 离线、暗色模式、中英混排、render.js 唯一 innerHTML 出口。

## 0. 设计方向

**定位**:本机单人的"知识工作台"——长文阅读 + 队列评审 + 检索,工具密度,中英混排。

**美学方向:档案编辑部(Archival Editorial)**——像一间安静的资料室:纸张感的中性底、
墨色正文、青瓷色一点作签名色;标题用编辑感衬线,正文无衬线保 CJK 可读,元数据用等宽。
参照系:Obsidian 的密度 + Stripe 文档的阅读排版 + Linear 的工具手感,但用"[[wikilink]]
引用签"做出自己的产品记忆点。

**签名元素(不同质化关键):[[ 引用签 ]]**
所有 wikilink 渲染为带双方括号视觉的 chip(细边框、青瓷 hover 填充、前置 ⇒ 图标),
死链为虚线框;搜索/反链/图谱全站复用同一签样式。它是这个产品的"标志物",
且直接呼应系统核心的 wikilink 图结构。

**反 AI slop 自审**:无紫渐变 ✓;无 Inter/Roboto ✓;不是奶油底+陶土色( skill 点名的
slop 之一,故签名色选青瓷而非朱红)✓;不过度居中(工作台是满幅三栏)✓;字体非
Space Grotesk ✓。

## 1. Token 计划

### 色板(6 个命名色,CSS 变量,明暗双套)

| token | light | dark | 用途 |
|---|---|---|---|
| `--paper` | #f7f8f7 | #12161a | 主底(冷白,非奶油) |
| `--paper-raise` | #ffffff | #1a2027 | 卡片/面板 |
| `--ink` | #1c2420 | #dde5e0 | 正文(墨绿黑,非纯黑) |
| `--ink-dim` | #5d6b64 | #8a978f | 次要文字 |
| `--celadon` | #0d7a6f | #2dd4bf | **签名色**:链接、激活态、引用签 |
| `--line` | #dde3df | #2a333c | 发丝边框 |

功能色(低饱和,仅状态语义):candidate 琥珀 #b45309、approved 松绿 #15803d、
rejected/archived 灰、destructive 枣红 #b91c1c、via:link 青瓷描边。

### 字体(全部 vendor,Latin woff2 子集,CJK 走系统栈)

| 角色 | 字体 | 说明 |
|---|---|---|
| display(品牌/H1-H3/页标题) | **Newsreader** (OFL) | 编辑感衬线,optical size,~40KB woff2 子集 |
| body(正文/UI) | system stack(-apple-system, "Segoe UI", "Microsoft YaHei") | CJK 刚需;安静,不抢戏 |
| mono(元数据/代码/路径/score) | **IBM Plex Mono** (OFL) | ~35KB 子集;frontmatter 面板的"档案卡"感来源 |

排版刻度:正文 15px/1.75;阅读栏 max-width 720px;标题 scale 1.333(12/15/20/27/36)。

### 间距/圆角/阴影/动效

- 间距 4 基数(4/8/12/16/24/32/48);圆角:面板 10px、chip 6px、按钮 8px;
- 阴影:仅 2 级(卡片 hairline+微阴影 / 浮层 16px 扩散),暗色下用发光边框替代;
- 动效 3 档:120ms(hover)/200ms(面板进出)/300ms(页面切换,stagger 40ms);
  全程 `prefers-reduced-motion` 降级;
- 签名动效:页面加载时阅读栏 fade+rise(8px),左侧树 stagger 滑入——一次编排好的
  入场,胜过散落的微交互。

## 2. 布局优化(现状痛点 → 方案)

```
┌──────────────────────────────────────────────────────────────┐
│ ▦ KB Portal ▾work   ⌕ Ctrl+K        ● 待治理   🌙  (40px 顶栏)│
├───┬────────────────┬───────────────────────────┬─────────────┤
│铁 │ 树(可收合)      │ 阅读栏(max720,居中留白)      │ 上下文面板     │
│路 │ ┌──────────┐ │ 标题(Newsreader)          │ [信息][反链]  │
│由 │ │🔍过滤     │ │ 状态签+档案卡(mono)        │ [大纲]       │
│60px│ sources ▾  │ ─────────────────────       │ scroll-spy │
│图标│  topics ▾   │ 正文 15/1.75,[[引用签]]      │             │
├───┴────────────────┴───────────────────────────┴─────────────┤
│ 底部状态条:KB 路径 · 页数 · 索引新鲜度            (28px, mono) │
└──────────────────────────────────────────────────────────────┘
```

1. **顶栏瘦身**(56→40px)+ **底部状态条**:KB 路径、页数、索引新鲜度——档案馆的"铭牌",
   mono 小字,是把"工具感"做实的关键细节;
2. **树面板可收合**为 60px 图标路由轨(localStorage 记忆),阅读时让出全部宽度;
   树内加**过滤输入**(打字母即筛)和分组折叠记忆;
3. **阅读栏收窄居中**(720px measure),长文阅读的核心体验;标题下是"档案卡"
   (mono 字体的 frontmatter 摘要行)而非现在的右侧列表;
4. **右栏改 tab 化上下文面板**:信息 / 反链 / **大纲(TOC scroll-spy,新增)**——
   长文档导航目前完全缺失;
5. **dashboard 重排**:顶部"档案摘要条"(一段自然语言:共 N 页、X 待审、最后治理时间)
   + 统计卡组(数字用 display 字体)+ 最近治理时间线(log.md,D2);
6. **评审页**:操作条吸底(approve/reject 大按钮 + 快捷键提示),diff 支持并排/逐行切换;
7. **空态即行动邀请**(skill UX writing 章):空 KB = "投入第一批文档 →"引导卡,
   空搜索结果 = 查询建议(去掉过滤器/换词),不道歉、给下一步。

## 3. 交互优化清单

| # | 交互 | 实现(vendor) |
|---|---|---|
| I1 | **Ctrl+K 命令面板**:搜页面/跳视图/执行动作,签名级交互 | hotkeys-js + 自绘面板(Alpine) |
| I2 | 列表键盘导航:j/k 移动、Enter 打开、队列里 a 批准 / r 拒绝、[ ] 上一篇/下一篇 | hotkeys-js |
| I3 | **wikilink 悬停预览**(Quartz 式):悬停 300ms 弹出目标页摘要卡 | tippy.js + /api/page 摘要 |
| I4 | 搜索:输入防抖 300ms 即时搜;type:/source:/tag: 做成可点 chips(不再手敲语法);结果关键词高亮(mark);骨架屏 | Alpine |
| I5 | 树过滤/折叠记忆;当前页在树中自动滚动可见 | Alpine + localStorage |
| I6 | TOC scroll-spy 高亮当前小节;标题 hover 显锚点链接(点击复制) | IntersectionObserver |
| I7 | 面板切换/页面切换过渡(200ms fade+rise,stagger 40ms);按钮按压 120ms | CSS transition |
| I8 | tooltip 全覆盖(图标按钮、状态签、score 含义) | tippy.js |
| I9 | 评审操作:乐观 UI + 409 时明确的冲突提示条(非静默) | Alpine |
| I10 | 暗色切换平滑过渡(color-scheme + 200ms 变量渐变) | CSS |

## 4. 依赖与验收

- 新增 vendor:pico.min.css(11.7KB gz)、alpine cdn(16.7KB)、hotkeys-js(3.5KB)、
  tippy bundle+css(9.1KB)、lucide-static 按需 ~40 个 SVG(<20KB)、
  Newsreader + IBM Plex Mono woff2 子集(<80KB)——合计 **≈120KB gzip,仍零构建零 npm**;
- 自写 CSS 现状全删,只留:布局 grid + token 变量覆盖 + 签名组件(引用签/档案卡/
  命令面板/状态条),预计 <400 行;
- render.js 唯一出口红线不变;DOMPurify 配置放行 chip 的 class;
- 测试增补:暗色变量存在性、wikilink chip 的 class 白名单、空态文案快照(可选);
- 里程碑:样式重做属 M7a slice 2,一次做完;I3 悬停预览与 I4 搜索 chips 若超时可砍,
  不伤主线。

## 5. 明确不做

- 不引 Tailwind/构建链;不引 Shoelace(9.4MB vendor);不用 emoji 当图标(lucide 替换);
- 不做响应式移动端(用户已排除);不做主题商店(明暗两套即止)。
