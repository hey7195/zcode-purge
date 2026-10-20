// 路径探测：找到 ZCode 安装根、引擎 zcode.cjs、用户数据根。
// 不写死盘符：环境变量 → 注册表 InstallLocation → 常见安装目录 → 盘符扫描。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ENGINE_REL = path.join('resources', 'glm', 'zcode.cjs');

export function exists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readRegistryInstallLocations() {
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const found = [];
  for (const root of roots) {
    let out = '';
    try {
      out = execFileSync('reg', ['query', root, '/s', '/f', 'ZCode', '/t', 'REG_SZ'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15000,
      });
    } catch {
      continue;
    }
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/InstallLocation\s+REG_SZ\s+(.+)$/i);
      if (m) found.push(m[1].trim().replace(/^"|"$/g, ''));
    }
  }
  return found;
}

function scanDriveRoots() {
  const names = ['ZCode', 'Zcode', 'zcode'];
  const hits = [];
  const letters = [];
  for (const ch of 'CDEFGHIJKLMNOPQRSTUVWXYZ') letters.push(ch);
  // 只探测根目录一级，代价可忽略；不递归。
  for (const L of letters) {
    const root = `${L}:\\`;
    if (!exists(root)) continue;
    for (const n of names) {
      const p = path.join(root, n);
      if (exists(path.join(p, ENGINE_REL))) hits.push(p);
    }
  }
  return hits;
}

function candidateRoots() {
  const cands = [];
  const push = (p) => {
    if (p && !cands.includes(p)) cands.push(p);
  };

  push(process.env.ZCODE_HOME);
  push(process.env.ZCODE_INSTALL_DIR);

  for (const loc of readRegistryInstallLocations()) push(loc);

  const local = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  if (local) push(path.join(local, 'Programs', 'ZCode'));
  if (pf) push(path.join(pf, 'ZCode'));
  if (pf86) push(path.join(pf86, 'ZCode'));

  for (const p of scanDriveRoots()) push(p);
  return cands;
}

/** 返回 { root, engine } 或 null */
export function findZCodeInstall() {
  for (const root of candidateRoots()) {
    const engine = path.join(root, ENGINE_REL);
    if (exists(engine)) return { root, engine };
  }
  return null;
}

/** 用户数据根：~/.zcode（cli/ 与 v2/ 都在其下） */
export function userDataRoot() {
  if (process.env.ZCODE_USER_HOME) return process.env.ZCODE_USER_HOME;
  return path.join(os.homedir(), '.zcode');
}

/** ZCode 用户配置文件：~/.zcode/cli/config.json（MCP + hooks 都在这） */
export function cliConfigPath() {
  return path.join(userDataRoot(), 'cli', 'config.json');
}

/** 本工具自己的状态目录：~/.zcode/purge */
export function purgeRoot() {
  return path.join(userDataRoot(), 'purge');
}

export function promptInjectPath() {
  return path.join(purgeRoot(), 'prompt-inject.md');
}

export function hooksDir() {
  return path.join(purgeRoot(), 'hooks');
}

export function backupPath(file) {
  return `${file}.zcpurge.bak`;
}
