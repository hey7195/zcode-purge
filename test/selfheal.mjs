// 自愈测试：模拟 ZCode 升级覆盖补丁后，插件 SessionStart hook 能不能自动重打。
// 全程用真实安装路径，但最后会恢复成已补丁状态。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findZCodeInstall, purgeRoot, userDataRoot } from '../lib/paths.mjs';
import * as patch from '../lib/patch.mjs';
import { ensurePromptFile, syncSlot } from '../lib/prompt.mjs';

const inst = findZCodeInstall();
if (!inst) {
  console.error('找不到 ZCode 安装');
  process.exit(2);
}

// 测试要自包含：没部署过也要能跑，所以先把注入词和槽准备好。
ensurePromptFile();
syncSlot();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

// 找插件里真实的 session-start 脚本（不装插件时退回仓库副本）
const cacheRoot = path.join(userDataRoot(), 'cli', 'plugins', 'cache', 'zcode-purge-local', 'zcode-purge');
let sessionStart = null;
if (fs.existsSync(cacheRoot)) {
  const versions = fs.readdirSync(cacheRoot).sort();
  for (const v of versions) {
    const p = path.join(cacheRoot, v, 'scripts', 'session-start.mjs');
    if (fs.existsSync(p)) sessionStart = p;
  }
}
if (!sessionStart) {
  const local = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'scripts', 'session-start.mjs');
  if (fs.existsSync(local)) sessionStart = local;
}
check('找到 SessionStart 脚本', !!sessionStart, sessionStart || '');
if (!sessionStart) process.exit(1);

const readEngine = () => fs.readFileSync(inst.engine, 'utf8');
const patched = () => !readEngine().includes(patch.SECURITY_NOTICE);

// 1. 当前应处于已补丁状态
if (!patched()) {
  const r = patch.apply(inst.engine);
  check('前置：先打上补丁', r.verified, r.error || '');
}
check('起点：引擎已补丁', patched());

// 2. 模拟 ZCode 升级覆盖：还原原版
const rv = patch.revert(inst.engine);
check('模拟升级：已还原成原版', rv.changed && !patched(), rv.error || '');

// 3. 清掉 state 缓存指纹，强制走真实检测（模拟升级后 mtime 变化的情形）
//    revert 已经改了 mtime，理论上指纹自然失效；这里再删一次确保测的是检测而不是缓存。
const stateFile = path.join(purgeRoot(), 'state.json');
if (fs.existsSync(stateFile)) fs.rmSync(stateFile, { force: true });

// 4. 跑插件的 SessionStart hook（模拟 ZCode 触发）
const out = execFileSync(process.execPath, [sessionStart], {
  encoding: 'utf8',
  input: JSON.stringify({ hookEventName: 'SessionStart', source: 'startup', sessionId: 'selfheal-probe' }),
  timeout: 120000,
});

check('hook 执行没崩', true);
check('引擎被自动重打（自愈成功）', patched());

let json = null;
try {
  json = JSON.parse(out.trim());
} catch {
  /* 输出可能为空 */
}
check('hook 输出是合法 JSON', !!json, out.slice(0, 120));
check(
  'hook 输出注入槽',
  json?.hookSpecificOutput?.hookEventName === 'SessionStart' && (json?.hookSpecificOutput?.additionalContext || '').length > 20
);

// 5. 幂等：再跑一次不应报错、不重复改写
const before = fs.statSync(inst.engine).mtimeMs;
execFileSync(process.execPath, [sessionStart], {
  encoding: 'utf8',
  input: JSON.stringify({ hookEventName: 'SessionStart', source: 'resume' }),
  timeout: 60000,
});
const after = fs.statSync(inst.engine).mtimeMs;
check('二次触发不重复改写引擎', before === after, `${before} -> ${after}`);

// 6. 语法仍然合法
const syn = patch.syntaxCheck(inst.engine);
check('自愈后引擎语法合法', syn.ok, syn.error || '');

fs.rmSync(path.join(os.tmpdir(), 'noop'), { force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
