# Spike P2-2:headless claude 写路径限定(2026-08-02/03,八轮实证)

> 任务:落实裁决 ⑧A——把 agent 的文件写限定在 KB 内,工具层强制。
> 方法:D:\tmp\perm-spike{1..8}\*.mjs 真实驱动 headless claude,以**文件是否实际落盘**
> 为 ground truth。提示词全部走 stdin(M7c 教训),路径全部写文件不走 bash -e(反斜杠教训)。

## 结论(最终姿态)

**`--permission-mode acceptEdits` + 按部署生成的 settings allow-list**,取代
`--dangerously-skip-permissions`(裁决 ④ 据此修订——skip-permissions 与路径规则
**互斥**,见 R1/R2;用户批准的 A 方向只有 acceptEdits 能实现)。

生成的 allow-list(ui/lib/executor.mjs buildAgentSettings → `<kb>/.kb/ui/agent-settings.json`):

```json
{ "permissions": { "allow": [
  "Bash(node <repo>/**)",        // 治理脚本可带参数运行;node -e 被拒
  "Bash(git status:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git diff:*)",
  "Read(<repo>/**)"              // agent 必须能读 SKILL.md(注册无关设计的前提)
] } }
```

效果(全部实证):KB 内 Write/Edit 自动接受;KB 外写自动拒绝(headless 无法交互);
allow-list 内 Bash 自动放行;其他 Bash 一律拒绝且不挂起;KB 外 Read 拒绝,
repo 内 Read 放行。**没有任何场景挂起等待。**

## 八轮关键事实

| 轮 | 发现 |
|---|---|
| R1-T1 | skip-permissions 下 deny [Write] **生效**(Write 工具被禁)——但 agent 立即用 Bash printf 绕过,文件落盘 |
| R1-T2 | skip-permissions 下**路径级** deny/allow 规则全部失效(两边都写成功) |
| R1-T3 | 默认模式 headless 下未授权写**自动拒绝不挂起**(好消息);但 settings 的 allow 路径规则不生效(语法?) |
| R2 | settings allow 规则对 Write **从不自动批准**——连 `Write(**)` 也不行(四种语法全试);skip-perms+路径 deny(S4)确认无效 |
| R3-S7/S9 | `--allowedTools` CLI 旗标同样不自动批准(连 Write(**)) |
| R3-S10 | **突破**:`acceptEdits` 有内建 cwd 边界——cwd 内写自动接受,cwd 外写需批准→headless 自动拒绝,无需任何路径规则 |
| R4-S11/S12 | acceptEdits 下裸 Bash 被拒;settings 的 **Bash allow 规则在 headless 下生效**(与 Write 规则行为不对称) |
| R4-S13 | 未授权的 Bash 命令写 cwd 外时,被"outside working directory"检测**拦截** |
| R5-S14 | 但 `allow: ["Bash"]` 裸放行**会绕过**该检测(外部写成功)——Bash 必须前缀限定 |
| R6-S16 | `Bash(node <repo>/:*)` 匹配**无参数**调用;`D:` 盘符冒号不破坏规则解析;KB 外 Read 被拒(发现 SKILL.md 可读性问题 → Read(repo/**)) |
| R6-S17/S18 | `node -e` 被拒 ✓;**反斜杠调用形式不匹配规则**——提示词必须规定正斜杠调用形式 |
| R7-S19 | `Read(<repo>/**)` allow 规则 headless 下生效 ✓ |
| R8(回归后) | e2e 发现带参数的脚本调用被拒:**`:*` 前缀形式不匹配带参数命令**;`/**` glob 形式与脚本级 `:*` 都能匹配带参数命令 → 采用 `Bash(node <repo>/**)` |

## 残余暴露面(诚实记录)

1. **repo 脚本带敌意参数**:allow-list 放行了 repo 下全部脚本的任意参数调用。
   缓冲:三服务脚本按契约只写 KB 内;C 层(跑后 git diff)能检出 KB 内异常写。
2. **运行前已脏的路径无法归因**(C 层只报"新增脏文件",pre-dirty 是盲区)。
3. 提示词注入仍可让 agent 在 **KB 内**做坏事——这是设计内的(candidate 评审 +
   作业日志双保险覆盖的范围)。
4. 非 git KB 没有 C 层检测(只有 A+B)。

## e2e 验证(演示 KB,两次真实运行)

- 运行 1(旧 `:*` 规则):脚本调用被拒 → agent 手工复刻脚本格式产出 candidate;
  KB 内 Write/Edit 自动接受 ✓;KB 外 Read(SKILL.md)放行 ✓;ls/date/cat 等非
  allow-list 命令被拒且 agent 绕行成功 ✓。
- 运行 2(`/**` 规则):`govern.mjs plan --kb .` **带参数执行成功** ✓;agent 正确
  识别上一轮产物并避免重复;C 层 git diff 无越界报告 ✓。
