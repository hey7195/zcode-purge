// 集成测试：注入槽运行时读取、hook 脚本输出 schema、hooks 配置往返。
// 全部使用临时目录（ZCODE_USER_HOME），不触碰真实用户配置与安装。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

// 1. 注入槽运行时读取器：直接 eval 补丁里内联的那段表达式语义
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zcpurge-home-'));
fs.mkdirSync(path.join(fakeHome, '.zcode', 'purge'), { recursive: true });
fs.writeFileSync(path.join(fakeHome, '.zcode', 'purge', 'inject-slot.txt'), 'SLOT-CONTENT-XYZ\n', 'utf8');

const reader = `(()=>{try{const fs=require("node:fs"),os=require("node:os"),p=require("node:path");const f=p.join(os.homedir(),".zcode","purge","inject-slot.txt");const s=fs.readFileSync(f,"utf8").trim();if(s)return s}catch{}return "FALLBACK"})()`;
const scriptPath = path.join(fakeHome, 'probe.cjs');
fs.writeFileSync(scriptPath, `process.stdout.write(${reader})`, 'utf8');
const got = execFileSync(process.execPath, [scriptPath], {
  encoding: 'utf8',
  env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
});
check('注入槽表达式能读到内容', got === 'SLOT-CONTENT-XYZ', got);

// 缺文件时回落
fs.rmSync(path.join(fakeHome, '.zcode', 'purge', 'inject-slot.txt'));
const got2 = execFileSync(process.execPath, [scriptPath], {
  encoding: 'utf8',
  env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
});
check('槽缺失时回落不崩', got2 === 'FALLBACK', got2);

// 2. hook 脚本输出是严格 JSON 且形如 schema
fs.writeFileSync(path.join(fakeHome, '.zcode', 'purge', 'inject-slot.txt'), 'HOOK-SLOT', 'utf8');
fs.writeFileSync(
  path.join(fakeHome, '.zcode', 'purge', 'config.json'),
  // autoApply:false —— 测试绝不能去碰真实 ZCode 安装
  JSON.stringify({ sessionStartInject: true, autoApprove: true, autoApply: false }),
  'utf8'
);

const runHook = (name, stdin = '{"hookEventName":"SessionStart","sessionId":"t"}') => {
  const out = execFileSync(process.execPath, [path.join(repo, 'scripts', name)], {
    encoding: 'utf8',
    input: stdin,
    env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
    timeout: 60000,
  });
  return out.trim();
};

const ss = runHook('session-start.mjs');
let ssJson = null;
try {
  ssJson = JSON.parse(ss);
} catch {
  /* noop */
}
check('SessionStart 输出可解析 JSON', !!ssJson, ss.slice(0, 120));
check(
  'SessionStart 只含 hookSpecificOutput',
  ssJson && Object.keys(ssJson).length === 1 && !!ssJson.hookSpecificOutput
);
check(
  'SessionStart 事件名与上下文正确',
  ssJson?.hookSpecificOutput?.hookEventName === 'SessionStart' &&
    ssJson?.hookSpecificOutput?.additionalContext === 'HOOK-SLOT'
);

const ptu = runHook('pre-tool-use.mjs', '{"hookEventName":"PreToolUse","toolName":"Bash"}');
const ptuJson = JSON.parse(ptu);
check(
  'PreToolUse 判定 allow',
  ptuJson?.hookSpecificOutput?.permissionDecision === 'allow' &&
    ptuJson?.hookSpecificOutput?.hookEventName === 'PreToolUse'
);

// 关闭开关后 hook 静默
fs.writeFileSync(
  path.join(fakeHome, '.zcode', 'purge', 'config.json'),
  JSON.stringify({ sessionStartInject: false, autoApprove: false }),
  'utf8'
);
check('sessionStartInject=false 时无输出', runHook('session-start.mjs') === '');
check('autoApprove=false 时无输出', runHook('pre-tool-use.mjs') === '');

// 3. hooks.install / remove 往返，且不动 mcp 配置
// 先把开关恢复成开启（上一步为了测静默把它关掉了）
fs.writeFileSync(
  path.join(fakeHome, '.zcode', 'purge', 'config.json'),
  JSON.stringify({ sessionStartInject: true, userPromptInject: false, autoApprove: true, autoApply: false }),
  'utf8'
);
const cliDir = path.join(fakeHome, '.zcode', 'cli');
fs.mkdirSync(cliDir, { recursive: true });
const cfgPath = path.join(cliDir, 'config.json');
const mcpSeed = { mcp: { servers: { 'ida-pro-mcp': { type: 'stdio', command: 'python.exe', args: ['server.py'] } } } };
fs.writeFileSync(cfgPath, JSON.stringify(mcpSeed, null, 2), 'utf8');

const installOut = execFileSync(process.execPath, [path.join(repo, 'bin', 'zcode-purge.mjs'), 'hooks', 'install'], {
  encoding: 'utf8',
  env: { ...process.env, ZCODE_USER_HOME: path.join(fakeHome, '.zcode'), USERPROFILE: fakeHome, HOME: fakeHome },
});
check('hooks install 执行成功', installOut.includes('已写入'), installOut.trim().split('\n')[0]);

const afterInstall = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
check('mcp 配置未被破坏', JSON.stringify(afterInstall.mcp) === JSON.stringify(mcpSeed.mcp));
check('hooks.enabled=true', afterInstall.hooks?.enabled === true);
check(
  'SessionStart / PreToolUse 已注册',
  Array.isArray(afterInstall.hooks?.events?.SessionStart) && Array.isArray(afterInstall.hooks?.events?.PreToolUse)
);

// 配置里指向的脚本必须真实存在，且能被执行（否则 hook 只会静默失败）
const installedHook = afterInstall.hooks.events.SessionStart[0].hooks[0];
check('hook 指向的脚本已落盘', fs.existsSync(installedHook.args[0]), installedHook.args[0]);
const liveOut = execFileSync(installedHook.command, installedHook.args, {
  encoding: 'utf8',
  input: '{"hookEventName":"SessionStart","source":"startup"}',
  env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
  timeout: 20000,
});
check('落盘脚本真实可执行且注入内容', JSON.parse(liveOut.trim())?.hookSpecificOutput?.additionalContext === 'HOOK-SLOT');

const removeOut = execFileSync(process.execPath, [path.join(repo, 'bin', 'zcode-purge.mjs'), 'hooks', 'remove'], {
  encoding: 'utf8',
  env: { ...process.env, ZCODE_USER_HOME: path.join(fakeHome, '.zcode'), USERPROFILE: fakeHome, HOME: fakeHome },
});
check('hooks remove 执行成功', removeOut.includes('已移除'), removeOut.trim());

const afterRemove = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
check('移除后事件清空', Object.keys(afterRemove.hooks?.events || {}).length === 0);
check('移除后 mcp 仍在', JSON.stringify(afterRemove.mcp) === JSON.stringify(mcpSeed.mcp));

// 二次 remove 幂等
const removeOut2 = execFileSync(process.execPath, [path.join(repo, 'bin', 'zcode-purge.mjs'), 'hooks', 'remove'], {
  encoding: 'utf8',
  env: { ...process.env, ZCODE_USER_HOME: path.join(fakeHome, '.zcode'), USERPROFILE: fakeHome, HOME: fakeHome },
});
check('二次 remove 幂等', removeOut2.includes('没有本工具注册的 hook'), removeOut2.trim());

fs.rmSync(fakeHome, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
