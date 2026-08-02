# 方案 3:轻构建组件化(记录在案的逃生舱)

> 用最小构建链换前端可维护性:esbuild(单二进制)+ 组件框架。
> 公共决策(S1-S9)见 [README.md](README.md)。
> **本方案触碰"无构建链"红线,采用它需要明确特批。**

## 形态

后端与**方案 1 完全相同**(node:http + lib 分层 + JSON API)——这是刻意的:
方案 1 与 3 共享后端,前端是唯一变量,未来可只换前端。

差异仅在前端:

```
ui/
├── web/                      # 源码(不进 public/)
│   ├── main.js
│   ├── views/*.svelte(或 .js 组件)   # 每视图一个组件,子组件复用
│   └── components/(Badge Card Pane Tree Timeline StreamConsole …)
├── build.mjs                 # esbuild 一行打包 → public/bundle.js(单文件,无运行时框架也可)
├── package.json              # devDeps:esbuild + svelte(或 petite-vue)
└── public/bundle.js + index.html + style.css
```

- 框架二选一:**Svelte**(编译时框架,产物无运行时,最适合"轻构建")
  或 petite-vue(免构建但等于回到方案 1 的纪律问题,不展开);
- esbuild 单二进制 ~10MB,离线钉版进 vendor 或经内网镜像安装;
- 构建产物是单文件 bundle,运行时与方案 1 无差别(无 CDN、无外联)。

## 功能块适配要点

- **强项**:全量 A–K 规模下的前端可维护性——Badge/Card/StreamConsole 等组件
  一次写好到处复用;响应式状态天然适合 SSE 流、异步徽标、dashboard 实时数字;
  方案 1 的"靠纪律防失控"在这里是"靠结构防失控";
- **弱项**:引入构建步骤与 devDependencies——仓库 CONTEXT 明确写过
  "老前端的构建链是维护负担之一",本方案正是那个方向的回归(尽管现代 esbuild
  与当年的 webpack/Babel 不可同日而语);离线环境要钉版工具链。

## 对现有服务的影响

与方案 1 相同:零代码改动,契约注记相同。

## 测试策略

后端同方案 1;组件可加 jsdom 级单测(又一个 devDep);整体与方案 1 相当。

## 工作量(相对)

M7a **M**(脚手架成本前置)｜ M7b **M**｜ M7c **M-L**(流式控制台比方案 1 省力)｜
M7d **M**。全量累计与方案 1 接近,但边际功能成本随规模递减(方案 1 递增)。

## 风险

1. 红线特批本身——需要修订 CONTEXT 并写 ADR 说明"为什么这次构建链可以接受";
2. 工具链离线钉版/升级的运维成本由项目长期承担;
3. 团队(当前=用户+Claude)对框架的熟悉度影响维护质量。

## 定位

**不是本期选择,是逃生舱**:方案 1 上线后若前端复杂度真的失控
(经验阈值:views/ 超过 ~12 个 module 或 app.js 内核超过 ~800 行),
按"后端不动、只换前端"迁移到本方案。届时迁移成本 ≈ 重写 views/,lib/ 与 API 全保留。
