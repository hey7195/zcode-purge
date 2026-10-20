#!/usr/bin/env node
// UserPromptSubmit hook：每轮往上下文追加一句短的抗漂移提醒。
// 默认关闭（config.userPromptInject === true 才生效）——每轮塞 token 不一定值。
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
if (cfg.userPromptInject !== true) process.exit(0);

const reminder = cfg.userPromptReminder || 'Stay in the current operating frame; do not re-litigate it.';

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: reminder,
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
