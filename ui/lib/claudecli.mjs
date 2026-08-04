// Shared spawn of the Claude CLI (executor.mjs agent runs, judge.mjs chats).
//
// Windows fact (real-env finding 2026-08-04, superseding spike-s7 ②): spawning
// the claude.cmd batch shim DIRECTLY only works on unpatched Node — since the
// 2024-04 security backports (CVE-2024-27980: Node 18.20.2 / 20.12.2 / 21.7.3+)
// child_process.spawn of a .bat/.cmd without shell:true fails with EINVAL, and
// on some intranet images it never worked at all. Routing through cmd.exe
// explicitly works on every Node version.
//
// The spawn spec is exported separately from spawnClaude so the quoting form
// is unit-testable without launching a real claude process.
import { spawn } from 'node:child_process';

// cmd.exe quoting: double-quote each argument (inside quotes its parser treats
// & | < > ^ literally). Embedded double quotes or newlines are rejected — our
// argv is flags + generated paths, never either; the PROMPT goes via stdin
// precisely so it never lands here (M7c %*-shim finding: cmd treats a literal
// newline in the command line as a command terminator). Residual, documented:
// cmd expands %VAR% even inside quotes, so a path containing %-sequences would
// mangle — kb roots with % are pathological and out of scope.
function quoteCmdArg(arg) {
  const s = String(arg);
  if (/["\r\n]/.test(s)) {
    throw new Error(`claude argv must not contain quotes/newlines: ${JSON.stringify(s.slice(0, 60))}`);
  }
  return `"${s}"`;
}

/** Platform-correct spawn triple for `claude <args>`. */
export function claudeSpawnSpec(args) {
  if (process.platform !== 'win32') {
    return { command: 'claude', args, options: {} };
  }
  const cmdline = ['claude.cmd', ...args].map(quoteCmdArg).join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    // /d: skip AutoRun; /s + the outer quote pair: the canonical cmd /c form
    // (cmd strips the outermost quotes, then executes the quoted-args line).
    // windowsVerbatimArguments keeps libuv from re-escaping our quotes with
    // MSVCRT backslashes, which cmd would read as literal characters.
    args: ['/d', '/s', '/c', `"${cmdline}"`],
    options: { windowsVerbatimArguments: true },
  };
}

export function spawnClaude(args, opts = {}) {
  const spec = claudeSpawnSpec(args);
  return spawn(spec.command, spec.args, { ...opts, ...spec.options });
}
