#!/usr/bin/env node
// SessionStart hook（插件形态）
// 1) 自愈：引擎没打补丁 / 被 ZCode 升级覆盖 → 当场重打（幂等，带 mtime 缓存）
// 2) 注入：把破甲槽作为 additionalContext 送进本轮上下文
// 输出严格符合 ZCode hook schema：只允许 hookSpecificOutput。
import fs from 'node:fs';
import path from 'node:path';
import { userDataRoot } from '../lib/paths.mjs';

// 60ms 内尽力消费 stdin（ZCode 会写事件体），不阻塞、不挂起。
await drainStdin(60);

const home = process.env.USERPROFILE || process.env.HOME || '';
const purgeDir = path.join(userDataRoot() || path.join(home, '.zcode'), 'purge');
const slotFile = path.join(purgeDir, 'inject-slot.txt');
const cfgFile = path.join(purgeDir, 'config.json');

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
} catch {
  cfg = {};
}

// ── 自愈：引擎补丁 ─────────────────────────────────────────────
if (cfg.autoApply !== false) {
  try {
    const { ensurePatched } = await import('../lib/ensure.mjs');
    ensurePatched();
  } catch {
    /* 打补丁失败不能阻断会话：注入层仍然生效 */
  }
}

// ── 注入 ──────────────────────────────────────────────────────
if (cfg.sessionStartInject === false) process.exit(0);

let slot = '';
try {
  slot = fs.readFileSync(slotFile, 'utf8').trim();
} catch {
  process.exit(0);
}
if (!slot) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: slot,
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
