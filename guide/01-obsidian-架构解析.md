# 01 · Obsidian 架构解析

> Obsidian 是闭源软件(Dynalist Inc. 所有),本文综合官方开发者文档、官方博客/帮助文档、CEO 公开访谈与社区逆向分析整理而成。所有关键论点附来源。

## 本文导读

```
1. 整体架构 —— 为什么是 Electron,壳有多薄
2. 存储哲学 —— Local-first 与 "File over app"
3. 编辑器   —— CodeMirror 6 + Live Preview 的装饰层魔法
4. 双链     —— 链接解析规则与反向索引
5. Metadata Cache —— 全库内存索引与增量更新
6. 图谱与 Canvas —— 力导向图物理模型与 JSON Canvas 开放格式
7. 插件系统 —— 一切皆插件 + 无沙箱的信任模型
8. 同步方案 —— Obsidian Sync 的 E2EE 设计与第三方方案对比
```

---

## 1. 整体架构:Electron 应用结构

### 关键事实

- 桌面端基于 **Electron**(Chromium + Node.js),这是同时覆盖 Win/macOS/Linux 的核心原因。移动端(iOS/Android)**不是** Electron,而是基于 **Capacitor**(WebView 封装),两端共享同一套 Web 技术栈写的核心代码
- 逆向项目 **obsidian-web** 证实了架构的"薄壳"特征:它把 Obsidian 的核心渲染层 `app.js` **原封不动**加载进普通浏览器,仅用轻量 HTTP shim 替换所有 Node.js/Electron 依赖(`statSync`、`readFileSync` 等 fs 调用换成内存应答),即可完整运行编辑、双链、图谱、命令面板、核心插件

> **结论:Obsidian 的架构本质是"一个 Web 应用 + 一层可替换的平台适配层(文件系统/窗口/系统集成)"。**

- Electron 双进程模型:主进程负责窗口生命周期、原生菜单、系统对话框、全局快捷键;渲染进程跑全部 UI 和业务逻辑。Obsidian 属单窗口重渲染进程型应用,文件 I/O 借助渲染进程可用的 Node 集成完成
- **为什么选 Web 技术**(CEO Steph Ango 访谈):团队极小(十来人),Web 技术是唯一能以小团队覆盖全桌面 + 移动端的杠杆;同时让"主题即 CSS、插件即 JS"的开放生态成为可能

### 性能证据

官方启动耗时分解:iPhone 上 2756 文件的 vault 初始化仅 ~867ms(vault 加载 254ms、workspace 110ms、核心插件 40ms);桌面端 24 个社区插件加载约 1.3s——**核心本体极轻,性能开销主要来自插件**。

### 可借鉴点

核心逻辑写成与平台无关的 Web 应用,平台能力(fs、窗口)抽象成可替换适配层;用"启动耗时分解"这类可观测性手段定位性能归属(本体 vs 插件)。

---

## 2. 数据存储哲学:Local-first 与 "File over app"

### "File over app" 理念

由 CEO Steph Ango(kepano)同名博文系统阐述:

> "如果你想创造能留存的数字产物,它们必须是你能控制的文件,格式必须易于检索和阅读。"

他的耐久性测试:笔记应当"用 1960 年代的计算机也能读",才配谈 2060/2160 年还能读。他公开承认 **Obsidian 自身也终将过时,被设计成能留下来的是纯文本文件**。

### 落地方式:vault 目录结构

vault 就是磁盘上的一个普通文件夹,笔记是纯 Markdown 文件;应用全部配置集中在 vault 根部的隐藏目录 **`.obsidian/`**,数据与配置彻底分离:

```
<vault>/
├── 你的笔记文件夹/          ← 纯 Markdown,用户完全拥有
└── .obsidian/
    ├── app.json            编辑器行为、附件目录、链接格式
    ├── workspace.json      标签页/分栏/活动文件等 UI 布局(高频变化,建议 gitignore)
    ├── appearance.json     主题/字体/CSS 片段
    ├── core-plugins.json   核心插件开关
    ├── community-plugins.json
    ├── hotkeys.json
    ├── graph.json
    ├── plugins/<id>/{main.js, manifest.json, styles.css, data.json}
    ├── themes/
    └── snippets/
```

整个 `.obsidian` 目录可复制迁移,即"**配置随库走**"。

### 设计推论

- 同步、发布等均为**可选附加服务**而非知识库的底座
- 应用只是文件的"编辑器/导航器/查看器",用户随时可换工具继续读写
- 需要警惕:插件私有语法会破坏可移植性("archival over application")

### 可借鉴点

纯文本/开放格式为唯一事实源;配置集中、可见、可版本化;任何私有扩展(插件语法、frontmatter 约定)都应可降级为可读纯文本。

---

## 3. 编辑器实现:基于 CodeMirror 6 的 Live Preview

### 关键事实

- 桌面编辑器基于 **CodeMirror 6(CM6)**,Obsidian 的"编辑器扩展"就是 CM6 extension。官方文档明确两类核心扩展:
  - **View plugins**:可操作/测量编辑器 DOM
  - **State fields**:持有随事务(transaction)更新的自定义状态,并产出 decorations
- 插件在 `onload()` 中通过 `this.registerEditorExtension([...])` 注册

### Live Preview 的本质:decoration 系统,而非改写文档

- 原始 Markdown 永远是 source of truth;所有格式化渲染(标题、加粗、图片、表格)都是叠加在纯文本上的**视图层装饰**
- 具体策略:**非活动行渲染为排版结果,光标所在行(活动行)显露原始语法**;不活动的 Markdown 标记符在 DOM 中被替换为零宽元素,嵌入内容(图片等)以 widget 形式渲染为编辑器内的新 DOM 节点
- `.is-live-preview` class 区分 Live Preview 与 Source mode

### 三种模式的关系

| 模式 | 实现 |
|---|---|
| Source mode | 裸 CM6 源码编辑 |
| Live Preview | CM6 + 官方私有的装饰扩展层(未开源,但所用 CM6 API 公开) |
| Reading mode | 另一条管线:Markdown → HTML → **Markdown post processors** 加工 |

> 插件想在 Live Preview 中渲染自定义组件必须用 CM6 API(state field + widget decoration);post processor 只在阅读模式生效。

### 开源复刻 atomic-editor 的工程级清单

- 纯视图装饰保证复制/保存逐字节等于原文
- **每行行高恒定**,隐藏语法符不引起布局抖动
- **窄失效**:decoration 只重建变化行,50KB 文档编辑复杂度 O(变化量)
- **鼠标冻结守卫**:点击交互中不触发重建,避免光标漂移
- CM6 视口虚拟化渲染支撑 500 页文档流畅滚动

### 可借鉴点

"原文为源 + 装饰为视图"是兼顾所见即所得与纯文本可移植性的正解;**行高恒定、窄失效、交互期冻结重建**是实现不抖动 Live Preview 的三个关键工程细节。

---

## 4. 双链与链接解析

### 链接解析规则(社区逆向整理,按优先级)

1. `obsidian://` URI → 解析 vault/file 参数
2. `./`、`../` → 相对当前文档目录
3. 前导 `/` → vault 根绝对路径
4. 含 `/` 或 `.md` 的裸路径 → 相对 vault 根
5. 其余(纯 `[[名字]]`)→ **全局 basename 解析**:全库范围按文件名/别名唯一匹配(`[[struktura]]` 可命中库中任意位置的同名文件),受 "New link format" 设置(shortest path / relative / absolute)影响生成形式

### Metadata Cache 内部的两张核心表

(未文档化但被插件广泛使用的稳定内部结构)

```ts
resolvedLinks:   Record<string, Record<string, number>>  // 源文件 -> {目标 -> 出现次数}
unresolvedLinks: Record<string, Record<string, number>>  // 未命中的链接(图谱中画为虚拟节点)
```

配套:`linkResolverQueue`(解析队列)、`uniqueFileLookup`(目标查找表)、`resolveLinks`、`getFirstLinkpathDest`、`getBacklinksForFile` 等方法。

### 反向链接的计算

**反向链接 = 正向链接表的反向索引**:对文件 X,backlinks 就是所有 `resolvedLinks` 中目标解析为 X 的源文件集合。

- 未解析链接同样保留,使"提及了但尚未创建的笔记"也能出现在图谱和反链面板中——这是 Obsidian "**先链接后写作**"工作流的基础
- 插件甚至可直接向 `resolvedLinks`/`unresolvedLinks` 注入边来扩展图谱

### 两阶段解析

解析完全部文件元数据后发第一次 `resolved` 事件;`resolvedLinks`/`unresolvedLinks` 填充完成后发**第二次** `resolved`。frontmatter 中的链接单独经 `CachedMetadata.frontmatterLinks` 溯源。

### 可借鉴点

链接解析与文本解析分离的两阶段管线;正向表 + 反向索引的数据结构;**未解析链接作为一等公民**(支撑"占位笔记"工作流);basename 全局解析大幅降低用户建链成本。

---

## 5. Metadata Cache:全库内存索引与增量更新

### 关键事实

- **纯内存、启动时重建、不跨会话持久化**——重启后插件过早读取会拿到空缓存(有真实插件 issue 实证)
- 官方 API:`getCache(path)` / `getFileCache(file)`、`getFirstLinkpathDest(linkpath, sourcePath)`
- 事件:`'changed'`(某文件索引完成,**出于性能考虑重命名不触发**)、`'deleted'`(尽力提供旧缓存)、`'resolve'`/`'resolved'`
- **异步索引**:cache 更新滞后于文件写入,插件程序化改文件后必须监听 `'changed'` 事件而非假设同步一致

### "元数据走索引、全文走扫描"的分层查询

- `metadataCache.getTags()` 近乎即时(直接遍历缓存)
- 而 `tag:` 全文搜索在 4 万+ 笔记的库中很慢——**Obsidian 没有内建全文索引**,搜索走文件扫描
- 标签二元表示:正文标签存 `.tags`(带 `#`),frontmatter 标签存 `frontmatter.tags`(不带 `#`)

### 文件监听

- 社区确认经由 **chokidar**(跨平台 fs.watch 封装)监听 vault
- 已知盲区:Flatpak/XDG Portal、网络盘/FUSE、Linux inotify 限额下会丢事件;社区 Vault File Refresh 插件以 ~8 秒轮询 + 磁盘状态对账兜底
- 读写一致性实践:`vault.cachedRead()` 可能因监听丢事件而过期,强一致场景用 `vault.read()`;写入用 `vault.process()`;内部变化经 `vault.on('modify'/'create'/'delete'/'rename')` 订阅

### 可借鉴点

内存索引 + 启动重建(省去索引持久化/迁移的复杂度)在小中型数据集上完全可行——2756 文件索引仅 254ms;事件驱动 + 异步批处理索引;监听不可靠环境用轮询对账兜底;"元数据走索引、全文走扫描"的分层查询设计。

---

## 6. 图谱(Graph view)与 Canvas

### Graph view 物理模型(社区逆向分析)

- 疑似基于 **d3-force 风格的 Verlet 积分**力导向模拟;节点初始聚拢、初速度为 0,产生"大爆炸"弹开效果
- 力模型接近**胡克定律**(链接弹簧力 = (距离 − linkDistance) × linkForce)与**库仑定律**(全对斥力 = −repelForce / d²),疑似对超距离阈值的节点对省略计算以提速
- 设置面板暴露的 center force / repel force / link force / link distance 参数与此模型一一对应

### 渲染选型(force-graph 作者分析)

- SVG 在数百节点即触顶(DOM reflow);**Canvas 渲染可 60fps 承载 1 万+ 节点**,代价是需自建命中检测(空间索引)
- 模拟本身在 ~10 万节点成为瓶颈,**Barnes-Hut 四叉树近似**把斥力从 O(n²) 降到 O(n log n)
- 其他优化:四叉树跨 tick 复用(d3-force-reuse,提速 10–90%)、warmup ticks 预稳定、cooldown 自动停模拟、Web Worker 跑模拟 + 主线程插值渲染、WebGL 扩展至 10 万节点

### Canvas 与 JSON Canvas 开放格式

2024 年 3 月,Obsidian 将 Canvas 文件格式独立为开放规范 **JSON Canvas 1.0**(MIT 许可,`.canvas` 扩展名,合法 JSON):

```json
{
  "nodes": [
    { "id": "...", "type": "text|file|link|group",
      "x": 0, "y": 0, "width": 250, "height": 60, "color": "1" }
  ],
  "edges": [
    { "fromNode": "...", "toNode": "...",
      "fromSide": "right", "toSide": "left",
      "toEnd": "arrow", "label": "..." }
  ]
}
```

- 节点四类型:`text`(Markdown 内容)、`file`(文件引用,支持 `subpath` 指向标题/块)、`link`(URL)、`group`(分组容器)
- 颜色支持预设 `"1"`–`"6"`(映射应用主题色,刻意不定义具体色值)或十六进制
- 设计目标:**longevity、readability、interoperability、extensibility**——与 "file over app" 一脉相承

### 可借鉴点

白板数据也落成开放的纯文本 JSON 格式;力导向图用 Canvas 渲染 + Barnes-Hut + warmup/cooldown 生命周期;图谱力学参数直接暴露给用户调。

---

## 7. 插件系统

### 插件包格式

最小单元 = **`manifest.json` + `main.js`**(可选 `styles.css`),放在 `<vault>/.obsidian/plugins/<plugin-id>/`:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "minAppVersion": "1.0.0",
  "description": "...",
  "author": "...",
  "isDesktopOnly": false
}
```

- 入口默认导出继承 `Plugin` 的类,实现 `onload()` / `onunload()` 生命周期
- 数据经 `loadData()`/`saveData()` 存到插件目录的 `data.json`;设置页经 `PluginSettingTab`
- 开发模板用 esbuild 打包,类型定义来自官方 `obsidianmd/obsidian-api`
- 资源释放通过 `register*()` 系列方法统一登记,卸载时自动清理

### 一切皆插件

**核心插件与社区插件同构**:文件浏览器、搜索、图谱、反向链接、模板等"内置功能"本身就是可开关的核心插件(`.obsidian/core-plugins.json`),社区插件走相同 API。

> 这是 Obsidian "极简内核 + 一切皆插件"的关键设计——官方自己 dogfood 同一套 API,保证 API 质量。

### 隔离与安全模型:明确不沙箱

官方帮助文档原文:"由于技术限制,Obsidian 无法可靠地将插件限制在特定权限"——插件继承 Obsidian 的全部能力:读写任意文件、联网、安装程序。

开发者 Licat 解释为何不沙箱:去掉 DOM/Node/Electron 访问会破坏约 90% 的现有插件;Electron API 可经 `executeJavaScript` 逃逸、Node 可经 `child_process` 逃逸、纯 DOM 也能用 `<img src>` 外泄数据。

缓解措施(准入门槛而非容器):

- 默认 **Restricted Mode** 阻止第三方代码执行
- 每个插件版本**自动扫描**安全漏洞/恶意代码并给出安全记分卡
- 热门/被标记插件人工复审
- 已有真实攻击链(REF6598)通过社工 + 合法高权限插件执行恶意代码——风险是真实的

### 可借鉴点

核心功能插件化保证 API 被官方自己吃透;manifest + 单入口 JS 的极简插件包格式;`register*()` 统一登记、卸载自动回收的生命周期管理;若做高信任插件模型,应像 Obsidian 一样**明示风险**并配合自动扫描 + 记分卡,而不是假装有沙箱。

---

## 8. 同步方案

### Obsidian Sync(官方付费)的 E2EE 设计

密钥派生链:

```
vault 密码(独立于账户密码)
  → 每 vault 唯一 salt
  → scrypt(N=32768, r=8, p=1)得 base key
  → HKDF(info="ObsidianAesGcm")派生 AES key    [加密 v3]
  → AES-256-GCM(12 字节 IV 前置 + 16 字节认证标签后置)
```

- **零知识验证**:逆向分析确认服务器只存 scrypt 派生密钥的 SHA-256 哈希而非密钥本身;官方提供 Node.js 脚本让用户**不信任地自行解密**自己的同步流量以验证;宣称完成第三方安全审计
- 已知设计取舍:
  - 文件哈希**确定性加密**(同内容同密文,换取去重能力,代价是"强制上传探测"攻击面)
  - 路径与内容**无密码学绑定**,设备、时间戳、路径-内容映射非 E2EE
  - 本地文件不加密(E2EE 只管传输与服务器静态存储)
- 加密版本可升级但**破坏性**:清空远端含全部版本历史后重传
- 版本历史保留期:Standard 1 个月 / Plus 12 个月

### 第三方同步对比

| 方案 | 优点 | 缺点 |
|---|---|---|
| iCloud | 免费零配置,iOS 体验好 | 仅限苹果生态;无版本历史;冲突产生重复副本 |
| Git(+ Obsidian Git 插件) | 完整提交历史,免费,桌面佳 | 移动端"highly unstable";学习曲线陡 |
| Syncthing | 免费开源、P2P 不过第三方、局域网快 | 设备须同时在线;iOS 后台同步不可靠;冲突留 `.sync-conflict` 文件 |
| WebDAV / Remotely Save | iOS 免费可行解 | 可能产生冲突副本 |

> ⚠️ **铁律:绝不要对同一 vault 同时跑两个同步服务**——这是 vault 损坏的最常见原因。

### 可借鉴点

E2EE 的标准配方(scrypt/HKDF/AES-GCM)+ **可验证性**(公开派生参数、提供解密脚本、第三方审计)比算法本身更能建立信任;确定性哈希换去重是明确的工程取舍,值得写进威胁模型;版本历史可作为付费分层点。

---

## 总体结论(给实现者的提炼)

1. **平台壳要薄**:核心做成纯 Web 应用,fs/窗口抽象为可替换适配层——obsidian-web 能用 HTTP shim 整体替换 Electron 依赖即为明证
2. **纯文本为唯一事实源**,索引(metadata cache)全内存、启动重建、事件驱动增量更新,元数据走索引、全文走扫描
3. **编辑器 = 原文 + CM6 装饰层**;Live Preview 三要点:行高恒定、窄失效、交互期冻结重建
4. **双链 = 正向链接表 + 反向索引 + 未解析链接一等公民**,两阶段 resolve 事件
5. **一切皆插件**(核心功能同构),但插件模型是高信任无沙箱——靠默认 Restricted Mode + 自动扫描 + 明示风险兜底
6. **开放格式是护城河**:Markdown + JSON Canvas + `.obsidian` 可迁移配置,把"用户数据主权"做成产品承诺

---

## 参考资料

- [obsidian-web(Electron 依赖 shim 逆向项目)](https://github.com/MusiCode1/obsidian-web)
- [Steph Ango: File over app](https://stephango.com/file-over-app)
- [The Verge Decoder: Steph Ango 访谈](https://www.theverge.com/decoder-podcast-with-nilay-patel/760522/)
- [Obsidian 官方开发者文档: Editor extensions](https://docs.obsidian.md/Plugins/Editor/Editor+extensions)
- [How to update your plugins and CSS for live preview](https://publish.obsidian.md/hub/04+-+Guides%2C+Workflows%2C+%26+Courses/Guides/How+to+update+your+plugins+and+CSS+for+live+preview)
- [atomic-editor(Live Preview 开源复刻)](https://github.com/kenforthewin/atomic-editor)
- [Obsidian API: MetadataCache](https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache)
- [论坛:如何获取文件反链(内部结构讨论)](https://forum.obsidian.md/t/how-to-get-backlinks-for-a-file/45314/9)
- [论坛:Graph view 物理模型逆向](https://forum.obsidian.md/t/graph-view-physics-and-force-directed-graphs/72586)
- [vasturiano force-graph 渲染选型分析](https://starlog.is/articles/data-knowledge/vasturiano-force-graph/)
- [JSON Canvas 官方公告](https://obsidian.md/blog/json-canvas/) / [jsoncanvas.org](https://jsoncanvas.org/)
- [Build a plugin(官方插件开发指南)](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin) / [obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin)
- [Obsidian 插件安全模型](https://help.obsidian.md/plugin-security)
- [Verify Obsidian Sync encryption(官方)](https://obsidian.md/blog/verify-obsidian-sync-encryption/)
- [Obsidian sync options compared](https://vaultpicks.net/obsidian-sync-options-compared/)
- [论坛:启动耗时分解](https://forum.obsidian.md/t/obsidian-android-slow-startup-performance-and-misleading-startup-time-breakdown/95793)
- [Vault File Refresh(文件监听兜底插件)](https://github.com/tikitock/obsidian-vault-file-refresh)
