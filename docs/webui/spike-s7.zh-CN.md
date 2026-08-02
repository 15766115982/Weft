# S7 spike 报告:headless claude 执行器三未知验证(2026-08-02)

> 环境:Windows 10 + Node 20.11 + Claude Code 2.1.214,真实进程实测(非文档推断)。
> 目的:在 M7a 开工前钉死 executor 接口的三个实现级未知(评审 P0-3)。

## ① stream-json 实时性 —— ✅ 确认实时,事件模型可定

`claude.cmd -p "<prompt>" --output-format stream-json --verbose`:

- 首行(system/init)0.7s 到达,后续事件**渐进到达**(非进程结束一次性吐出);
- 一次最小运行 18 行 JSONL,事件 `type` 全集:`system` / `assistant` / `result`;
- 观测到的 subtype:`system.init`(带 cwd/session_id)、`system.thinking_tokens`
  (增量 token 计数)等;
- **executor 事件模型定为 stream-json 事件的子集**:init / assistant 增量 / result,
  逐行 JSON.parse,解析失败的行降级为原始文本事件(fail-safe)。

## ② Windows spawn —— ✅ `claude.cmd` 直生,不带 shell

| 方式 | 结果 |
|---|---|
| `spawn('claude')`(无 shell) | **ENOENT**(评审 P0-3 预判正确:.cmd shim 不能被 CreateProcess 直执) |
| `spawn('claude', {shell:true})` | 可用,但 shell 插值引入引号/注入面,不采用 |
| `spawn('claude.cmd')`(无 shell) | ✅ **可用,采用** |

附加教训:spawn 的 `cwd` **必须是 Windows 路径**——Git Bash 的 `/tmp/...` 传给
Windows Node 会以 ENOENT 失败(一次测试误报由此产生)。executor 的 cwd 永远用
`path.resolve` 后的 KB 路径,天然满足。

## ③ headless 权限姿态 —— ✅ 两条路都验证,选择权交用户

| 姿态 | 实测 |
|---|---|
| 默认(无权限 flag) | 工具写被拦:**文件未创建**,agent 在 result 文本中说明"write was blocked",**exit 0、is_error false** |
| `--dangerously-skip-permissions` | 文件成功创建,内容正确 |
| `--allowedTools` 精细白名单 | 未实测(文档能力);如需可在 M7c 前补一次小探针 |

**关键工程含义:exit code 不是错误信号**——被拦也是 exit 0。executor 必须解析
`result` 事件(subtype/is_error/文本)判断成败,与 acquisition "不能只看 exit code"
的既有教训同款。

## 回填

- S7 事件模型:stream-json JSONL 子集(init / assistant / result),逐行解析;
- spawn 方式:`spawn('claude.cmd', args, { cwd: <windows-kb-path> })`,无 shell;
- 权限姿态:用户 2026-08-02 拍板 `--dangerously-skip-permissions`(M7c);
- **修正(M7c e2e 发现):提示词必须走 stdin,不能占 argv**——claude.cmd 是
  %* 批处理垫片,cmd.exe 把命令行里的字面换行当命令终止符;多行提示词在 argv
  里产出零输出、无 result 事件(单行正常)。spike 当时只测了单行提示词,漏了这条。
