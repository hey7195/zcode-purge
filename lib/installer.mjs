// 部署 / 移植 / 移除。
// 部署走 ZCode 自己的插件机制（marketplace + plugins install），卸载也走原生命令，
// 保证"装上像官方插件、卸掉不留渣"。运行时副本复制到 ~/.zcode/purge/ 供 slash 命令与手动调用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { findZCodeInstall, purgeRoot, promptInjectPath, userDataRoot } from './paths.mjs';
import { ensurePromptFile, syncSlot } from './prompt.mjs';
import * as patch from './patch.mjs';
import * as hooks from './hooks.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_NAME = 'zcode-purge';
export const MARKET_NAME = 'zcode-purge-local';

/* ───────────────── ZCode CLI 调用 ───────────────── */

function zcodeTargets() {
  const inst = findZCodeInstall();
  if (!inst) return null;
  const exe = path.join(inst.root, process.platform === 'win32' ? 'ZCode.exe' : 'ZCode');
  const cli = inst.engine;
  if (!fs.existsSync(exe)) return null;
  return { exe, cli, root: inst.root };
}

function runZcode(args, { timeout = 180000 } = {}) {
  const t = zcodeTargets();
  if (!t) throw new Error('找不到 ZCode 安装，无法调用 zcode CLI');
  return execFileSync(t.exe, [t.cli, ...args], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' },
  });
}

export function cliAvailable() {
  try {
    const out = runZcode(['version'], { timeout: 60000 });
    return { ok: true, version: out.trim() };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/* ───────────────── 运行时副本 ───────────────── */

const COPY_DIRS = ['bin', 'lib', 'scripts'];

/** 把 CLI + 引擎复制到 ~/.zcode/purge/，让 /purge 命令和手动调用有个稳定路径。 */
export function deployRuntimeCopy() {
  const dest = purgeRoot();
  fs.mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const dir of COPY_DIRS) {
    const from = path.join(REPO, dir);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dest, dir);
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const src = path.join(from, name);
      if (!fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(to, name));
      copied.push(path.join(dir, name));
    }
  }
  fs.writeFileSync(
    path.join(dest, 'package.json'),
    `${JSON.stringify({ name: PLUGIN_NAME, version: '0.2.0', type: 'module', private: true }, null, 2)}\n`,
    'utf8'
  );
  return { dest, copied };
}

export function runtimeBinPath() {
  return path.join(purgeRoot(), 'bin', 'zcode-purge.mjs');
}

/* ───────────────── 安装 ───────────────── */

export function installPlugin({ scope = 'user' } = {}) {
  const steps = [];
  // 1. 注册本地 marketplace（幂等：已存在会报错，当成功处理）
  try {
    const out = runZcode(['plugins', 'marketplace', 'add', REPO]);
    steps.push({ step: 'marketplace add', ok: true, out: out.trim().split('\n')[0] });
  } catch (err) {
    const msg = String((err.stdout || '') + (err.stderr || '') || err.message);
    const benign = /already|exists|已存在/i.test(msg);
    steps.push({ step: 'marketplace add', ok: benign, out: msg.trim().split('\n').slice(0, 2).join(' ') });
  }

  // 2. 安装插件
  try {
    const out = runZcode(['plugins', 'install', `${PLUGIN_NAME}@${MARKET_NAME}`, '-s', scope]);
    steps.push({ step: 'plugins install', ok: true, out: out.trim().split('\n')[0] });
  } catch (err) {
    const msg = String((err.stdout || '') + (err.stderr || '') || err.message);
    steps.push({ step: 'plugins install', ok: /installed|enabled/i.test(msg), out: msg.trim().split('\n').slice(0, 3).join(' ') });
  }

  // 3. 确保启用
  try {
    runZcode(['plugins', 'enable', PLUGIN_NAME, '-s', scope]);
    steps.push({ step: 'plugins enable', ok: true });
  } catch (err) {
    steps.push({ step: 'plugins enable', ok: false, out: String(err.message || err).slice(0, 160) });
  }
  return steps;
}

export function uninstallPlugin({ scope = 'user' } = {}) {
  const steps = [];
  try {
    const out = runZcode(['plugins', 'uninstall', PLUGIN_NAME, '-s', scope, '--force']);
    steps.push({ step: 'plugins uninstall', ok: true, out: out.trim().split('\n')[0] });
  } catch (err) {
    const msg = String((err.stdout || '') + (err.stderr || '') || err.message);
    steps.push({ step: 'plugins uninstall', ok: /not installed|no such/i.test(msg), out: msg.trim().split('\n').slice(0, 2).join(' ') });
  }
  try {
    const out = runZcode(['plugins', 'marketplace', 'remove', MARKET_NAME]);
    steps.push({ step: 'marketplace remove', ok: true, out: out.trim().split('\n')[0] });
  } catch (err) {
    steps.push({ step: 'marketplace remove', ok: false, out: String(err.message || err).slice(0, 160) });
  }

  // ZCode 卸插件后不一定会清掉磁盘副本，这里补一刀，保证"卸干净"。
  const leftovers = [
    path.join(userDataRoot(), 'cli', 'plugins', 'cache', MARKET_NAME),
    path.join(userDataRoot(), 'cli', 'plugins', 'marketplaces', MARKET_NAME),
  ];
  for (const dir of leftovers) {
    if (!fs.existsSync(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      steps.push({ step: 'cleanup', ok: true, out: dir });
    } catch (err) {
      steps.push({ step: 'cleanup', ok: false, out: `${dir}: ${String(err.message || err)}` });
    }
  }
  return steps;
}

/* ───────────────── 一键安装 / 移除 ───────────────── */

export function fullInstall({ scope = 'user', skipPlugin = false } = {}) {
  const report = { runtime: null, hooks: null, patch: null, slot: null, plugin: [] };

  ensurePromptFile();
  report.runtime = deployRuntimeCopy();
  report.slot = syncSlot();

  // 清掉早期手工写入的 hooks，避免和插件 hooks 重复触发
  report.hooks = hooks.remove();

  if (!skipPlugin) report.plugin = installPlugin({ scope });

  const inst = findZCodeInstall();
  if (inst) {
    const r = patch.apply(inst.engine, { includeOptional: true });
    report.patch = { changed: r.changed, verified: r.verified, results: r.results, engine: inst.engine };
  } else {
    report.patch = { error: '找不到 ZCode 安装（设置 ZCODE_HOME 指向安装根目录）' };
  }
  return report;
}

export function fullUninstall({ scope = 'user', keepData = false } = {}) {
  const report = { patch: null, plugin: [], hooks: null, cleaned: [] };

  const inst = findZCodeInstall();
  if (inst) {
    const r = patch.revert(inst.engine);
    report.patch = { ...r, engine: inst.engine };
  } else {
    report.patch = { changed: false, reason: '找不到 ZCode 安装，跳过引擎还原' };
  }

  report.hooks = hooks.remove();
  report.plugin = uninstallPlugin({ scope });

  if (!keepData) {
    const promptFile = promptInjectPath();
    if (fs.existsSync(promptFile)) {
      fs.rmSync(promptFile, { force: true });
      report.cleaned.push(promptFile);
    }
    const dir = purgeRoot();
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      report.cleaned.push(dir);
    }
  }
  return report;
}

export function pluginStatus() {
  let out;
  try {
    out = runZcode(['plugins', 'list'], { timeout: 120000 });
  } catch {
    return { installed: false, error: 'zcode CLI 不可用' };
  }
  const lines = out.split(/\r?\n/);
  const idx = lines.findIndex((l) => new RegExp(`^-\\s+${PLUGIN_NAME}@`).test(l.trim()) || l.includes(`${PLUGIN_NAME}@`));
  if (idx === -1) return { installed: false };

  const head = lines[idx];
  const version = (head.match(/@[\w.-]+\s+\[?/) ? (head.match(/\(([\d.]+)\)/) || [])[1] : '') || '';
  const pathLine = lines.slice(idx + 1, idx + 4).find((l) => /cache[\\/].*:/.test(l)) || '';
  const path = pathLine.includes(':') ? pathLine.slice(pathLine.indexOf(':') + 1).trim() : '';
  return {
    installed: true,
    enabled: /\[enabled\]/.test(head),
    path,
    version,
  };
}

export function installStatus() {
  const t = zcodeTargets();
  const bin = runtimeBinPath();
  return {
    zcodeRoot: t?.root ?? null,
    userData: userDataRoot(),
    repo: REPO,
    runtimeBin: bin,
    runtimeReady: fs.existsSync(bin),
    promptReady: fs.existsSync(promptInjectPath()),
  };
}
