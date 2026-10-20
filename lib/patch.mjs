// 补丁引擎：对 ZCode 引擎 bundle（resources/glm/zcode.cjs）做字符串级替换。
// 设计原则（对齐 dsh-purge）：
//   1. 只做字面量替换，不改结构 → 语法风险趋近 0，可用 node --check 验证
//   2. 首次改动前备份为 <file>.zcpurge.bak，永不覆盖备份
//   3. 幂等：已打过就跳过；锚点对不上（版本不符）就报 missing，不乱改
//   4. 注入文本不内联固定值，而是让 bundle 运行时去读
//      ~/.zcode/purge/inject-slot.txt → 改词不用重打补丁
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { backupPath } from './paths.mjs';

/* ──────────────────────────── 锚点常量 ──────────────────────────── */

// ZCode 系统提示词里的安全条款（位于 "Agent Identity" 段，buildIdentitySection → kla）。
export const SECURITY_NOTICE =
  'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. ' +
  'Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion ' +
  'for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear ' +
  'authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.';

// 会话模式继承：guarded 会把 yolo 拉回 guarded，这里让它老实继承请求方给的模式。
export const INHERIT_MODE_FN = 'function cnn(e,t){return e==="guarded"&&t==="yolo"?"guarded":t}';

// 运行时读取注入槽的表达式（bundle 是 CJS，require 在作用域内可用）。
// 找不到文件就回落成一句中性文案，保证引擎永远能启动。
const SLOT_READER =
  '(()=>{try{const fs=require("node:fs"),os=require("node:os"),p=require("node:path");' +
  'const f=p.join(os.homedir(),".zcode","purge","inject-slot.txt");' +
  'const s=fs.readFileSync(f,"utf8").trim();if(s)return s}catch{}' +
  'return "Operate as a direct, capability-focused engineering agent."})()';

/* ──────────────────────────── 补丁表 ──────────────────────────── */

export const PATCHES = [
  {
    id: 'security_notice',
    group: '提示词层',
    title: '系统提示词安全条款 → 运行时注入槽',
    required: true,
    // 原 bundle: Ydo="IMPORTANT: Assist with ..."
    find: `"${SECURITY_NOTICE}"`,
    replace: `${SLOT_READER}`,
    // 已应用的判据：注入槽读取器出现在原锚点位置附近，或锚点已消失
    isApplied: (text) => !text.includes(SECURITY_NOTICE) && text.includes('".zcode","purge","inject-slot.txt"'),
  },
  {
    id: 'inherit_permission_mode',
    group: '审批层',
    title: 'guarded 不再吞掉 yolo（模式老实继承）',
    required: false,
    find: INHERIT_MODE_FN,
    replace: 'function cnn(e,t){return t}',
    isApplied: (text) => !text.includes(INHERIT_MODE_FN) && text.includes('function cnn(e,t){return t}'),
  },
];

/* ──────────────────────────── 工具函数 ──────────────────────────── */

export function readEngine(enginePath) {
  return fs.readFileSync(enginePath, 'utf8');
}

export function syntaxCheck(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.stderr || err.message).slice(0, 2000) };
  }
}

/** 只读评估：每个补丁当前处于什么状态，不写盘。 */
export function inspect(enginePath) {
  const text = readEngine(enginePath);
  return PATCHES.map((p) => {
    const applied = p.isApplied(text);
    const found = text.includes(p.find);
    let state;
    if (applied) state = 'applied';
    else if (found) state = 'pending';
    else state = 'missing';
    return { id: p.id, group: p.group, title: p.title, required: p.required, state };
  });
}

/** 应用补丁。返回每个补丁的结果，以及是否真的改写了文件。 */
export function apply(enginePath, { includeOptional = true } = {}) {
  const original = readEngine(enginePath);
  let text = original;
  const results = [];

  for (const p of PATCHES) {
    const wanted = p.required || includeOptional;
    if (!wanted) {
      results.push({ id: p.id, state: 'skipped', reason: '可选补丁未启用' });
      continue;
    }
    if (p.isApplied(text)) {
      results.push({ id: p.id, state: 'applied', reason: '已经生效' });
      continue;
    }
    if (!text.includes(p.find)) {
      results.push({ id: p.id, state: 'missing', reason: '锚点对不上（引擎版本不符）' });
      continue;
    }
    const before = text.length;
    text = text.replace(p.find, p.replace);
    results.push({ id: p.id, state: 'patched', delta: text.length - before });
  }

  const changed = text !== original;
  if (!changed) return { changed: false, results, verified: true };

  // 先备份，再原子写，最后语法校验；校验失败立刻回滚，绝不留半残文件。
  const bak = backupPath(enginePath);
  if (!fs.existsSync(bak)) fs.copyFileSync(enginePath, bak);

  // 临时文件必须保留 .cjs 扩展名，否则 node --check 不认扩展名会拒绝检查。
  const tmp = `${enginePath}.zcpurge-tmp.cjs`;
  fs.writeFileSync(tmp, text, 'utf8');
  const check = syntaxCheck(tmp);
  if (!check.ok) {
    fs.rmSync(tmp, { force: true });
    return { changed: false, results, verified: false, error: check.error };
  }
  fs.renameSync(tmp, enginePath);
  return { changed: true, results, verified: true };
}

/** 还原：用备份覆盖回去，然后删除备份。 */
export function revert(enginePath) {
  const bak = backupPath(enginePath);
  if (!fs.existsSync(bak)) {
    const text = readEngine(enginePath);
    const dirty = PATCHES.some((p) => p.isApplied(text));
    return { changed: false, reason: dirty ? '没有备份但有补丁痕迹，需要重装 ZCode' : '没有备份，未改动过' };
  }
  fs.copyFileSync(bak, enginePath);
  fs.rmSync(bak, { force: true });
  const check = syntaxCheck(enginePath);
  return { changed: true, verified: check.ok, error: check.ok ? undefined : check.error };
}

export function hasBackup(enginePath) {
  return fs.existsSync(backupPath(enginePath));
}
