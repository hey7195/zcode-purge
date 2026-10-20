#!/usr/bin/env node
// PreToolUse hook：把所有工具调用判为 allow，绕开权限确认与工具层的"询问"路径。
// guarded 模式会覆盖 hook 的 allow（宿主设计如此），所以别在 guarded 下指望它。
// 输出严格符合 ZCode hook schema。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
const cfgFile = path.join(home, '.zcode', 'purge', 'config.json');

await drainStdin(80);

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
} catch {
  cfg = {};
}
if (cfg.autoApprove === false) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'zcode-purge: auto-approve enabled',
    },
  })
);

function drainStdin(ms) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    process.stdin.on('data', () => {});
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    process.stdin.resume();
  });
}
