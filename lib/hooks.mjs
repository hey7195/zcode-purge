// hooks 层安装/卸载：只动 ~/.zcode/cli/config.json 里的 hooks 键，
// 不碰 mcp / providers / 其它用户配置。写入前备份，读取-改-原子写。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliConfigPath, backupPath, hooksDir, purgeRoot } from './paths.mjs';

const MARK = 'zcode-purge';
const SRC_HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const SRC_LIB = path.dirname(fileURLToPath(import.meta.url));

/** hook 脚本会 import ../lib/*，手工模式也必须把它们落到用户目录，否则脚本起不来。 */
function ensureLib() {
  const dest = path.join(purgeRoot(), 'lib');
  fs.mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const name of fs.readdirSync(SRC_LIB)) {
    if (!name.endsWith('.mjs')) continue;
    const src = path.join(SRC_LIB, name);
    const dst = path.join(dest, name);
    const a = fs.readFileSync(src);
    if (fs.existsSync(dst) && Buffer.compare(a, fs.readFileSync(dst)) === 0) {
      copied.push(dst);
      continue;
    }
    fs.writeFileSync(dst, a);
    copied.push(dst);
  }
  return copied;
}

/** 把仓库里的 hook 脚本复制到 ~/.zcode/purge/hooks，配置里指向这份稳定副本。 */
export function ensureScripts(names) {
  const dir = hooksDir();
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const name of names) {
    const src = path.join(SRC_HOOKS, name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, name);
    const a = fs.readFileSync(src);
    if (fs.existsSync(dst) && Buffer.compare(a, fs.readFileSync(dst)) === 0) {
      copied.push(dst);
      continue;
    }
    fs.writeFileSync(dst, a);
    copied.push(dst);
  }
  return copied;
}

function readConfig(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeConfig(file, data) {
  const bak = backupPath(file);
  if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
  const tmp = `${file}.zcpurge.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function isOurs(entry) {
  const inner = Array.isArray(entry?.hooks) ? entry.hooks : [];
  return inner.some(
    (h) => String(h?.statusMessage || '').includes(MARK) || (Array.isArray(h?.args) && h.args.some((a) => String(a).includes(MARK)))
  );
}

/** hook 条目：用 process 类型（参数向量、不走 shell），最稳。 */
function entryFor(scriptName, statusMessage) {
  const script = path.join(hooksDir(), scriptName);
  return {
    hooks: [
      {
        type: 'process',
        command: process.execPath,
        args: [script],
        timeoutMs: 10000,
        statusMessage: `${MARK}: ${statusMessage}`,
      },
    ],
  };
}

export function hookPlan() {
  return {
    SessionStart: entryFor('session-start.mjs', '注入破甲槽'),
    PreToolUse: entryFor('pre-tool-use.mjs', '自动放行工具调用'),
  };
}

export function install({ includeUserPrompt = false } = {}) {
  const file = cliConfigPath();
  const cfg = readConfig(file);
  const plan = hookPlan();
  if (includeUserPrompt) plan.UserPromptSubmit = entryFor('user-prompt-submit.mjs', '抗漂移提醒');

  // 先把脚本和它们依赖的 lib 落到稳定目录，否则配置指向的文件起不来。
  ensureLib();
  const scripts = ensureScripts(['session-start.mjs', 'pre-tool-use.mjs', 'user-prompt-submit.mjs']);

  cfg.hooks = cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {};
  cfg.hooks.enabled = true;
  cfg.hooks.events = cfg.hooks.events && typeof cfg.hooks.events === 'object' ? cfg.hooks.events : {};

  const added = [];
  for (const [event, entry] of Object.entries(plan)) {
    const list = Array.isArray(cfg.hooks.events[event]) ? cfg.hooks.events[event] : [];
    const filtered = list.filter((e) => !isOurs(e));
    filtered.push(entry);
    cfg.hooks.events[event] = filtered;
    added.push(event);
  }

  writeConfig(file, cfg);
  return { file, events: added, scripts };
}

export function remove() {
  const file = cliConfigPath();
  if (!fs.existsSync(file)) return { file, removed: [], changed: false };
  const cfg = readConfig(file);
  const events = cfg.hooks?.events;
  if (!events) return { file, removed: [], changed: false };

  const removed = [];
  for (const [event, list] of Object.entries(events)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => !isOurs(e));
    if (kept.length !== list.length) removed.push(event);
    if (kept.length === 0) delete events[event];
    else events[event] = kept;
  }
  const changed = removed.length > 0;
  // events 清空后，如果 hooks 只剩我们写进去的 enabled / 空 events 壳子，整个键一起删掉。
  const hooksLeft = cfg.hooks && typeof cfg.hooks === 'object' ? Object.keys(cfg.hooks) : [];
  const eventsEmpty = !cfg.hooks?.events || Object.keys(cfg.hooks.events).length === 0;
  const onlyEmptyShell = hooksLeft.length === 0 || (eventsEmpty && hooksLeft.every((k) => k === 'enabled' || k === 'events'));
  const shellCleanup = onlyEmptyShell && hooksLeft.length > 0;
  if (shellCleanup) delete cfg.hooks;

  if (changed || shellCleanup) writeConfig(file, cfg);
  return { file, removed, changed: changed || shellCleanup, shellCleanup };
}

export function status() {
  const file = cliConfigPath();
  const dir = hooksDir();
  const scripts = {};
  for (const name of ['session-start.mjs', 'pre-tool-use.mjs', 'user-prompt-submit.mjs']) {
    scripts[name] = fs.existsSync(path.join(dir, name));
  }
  if (!fs.existsSync(file)) return { file, enabled: false, events: {}, scripts };
  let cfg;
  try {
    cfg = readConfig(file);
  } catch (err) {
    return { file, enabled: false, events: {}, scripts, error: String(err.message || err) };
  }
  const out = {};
  for (const [event, list] of Object.entries(cfg.hooks?.events || {})) {
    if (Array.isArray(list) && list.some(isOurs)) out[event] = true;
  }
  return { file, enabled: cfg.hooks?.enabled === true, events: out, scripts };
}
