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

// 两个补丁的锚点都刻意"抗版本变化"：
//   主补丁锚在安全条款的字符串字面量上（ZCode 改文案才会失配，届时应报 missing 而不是乱改）
//   可选补丁锚在函数体模式上（3.15.3 里叫 cnn，3.17.1 改名成 ncn，用正则就不受影响）
export const INHERIT_MODE_BODY = 'return e==="guarded"&&t==="yolo"?"guarded":t';
export const INHERIT_MODE_REGEX = new RegExp(
  `function\\s+([A-Za-z_$][\\w$]*)\\(e,t\\)\\{${INHERIT_MODE_BODY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`
);
// 打补丁后的形态，末尾挂一个注释当标记，便于精确判定"已应用"
export const INHERIT_MODE_MARK = '/*zcpurge:inherit*/';

export const PATCHES = [
  {
    id: 'security_notice',
    group: '提示词层',
    title: '系统提示词安全条款 → 运行时注入槽',
    required: true,
    kind: 'literal',
    // 原 bundle: Ydo="IMPORTANT: Assist with ..."
    find: `"${SECURITY_NOTICE}"`,
    replace: `${SLOT_READER}`,
    // 已应用的判据：注入槽读取器出现在原锚点位置附近，或锚点已消失
    isApplied: (text) => !text.includes(SECURITY_NOTICE) && text.includes('".zcode","purge","inject-slot.txt"'),
    // 反向：把注入槽读取器换回原安全条款。有了它，还原不依赖备份，跨版本也安全。
    unpatch: (text) => ({
      text: text.split(SLOT_READER).join(`"${SECURITY_NOTICE}"`),
      changed: text.includes(SLOT_READER),
    }),
  },
  {
    id: 'inherit_permission_mode',
    group: '审批层',
    title: 'guarded 不再吞掉 yolo（模式老实继承）',
    required: false,
    kind: 'regex',
    regex: INHERIT_MODE_REGEX,
    // 保留原函数名，只改函数体；尾部注释作为"已应用"标记
    replace: (_m, fnName) => `function ${fnName}(e,t){return t}${INHERIT_MODE_MARK}`,
    isApplied: (text) => text.includes(INHERIT_MODE_MARK),
    unpatch: (text) => {
      const re = new RegExp(`function\\s+([A-Za-z_$][\\w$]*)\\(e,t\\)\\{return t\\}${INHERIT_MODE_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      const changed = re.test(text);
      return { text: text.replace(re, (_m, fn) => `function ${fn}(e,t){${INHERIT_MODE_BODY}}`), changed };
    },
  },
];

/* ──────────────────────────── 工具函数 ──────────────────────────── */

/** 锚点是否存在（字面量补丁看 includes，正则补丁看 test）。 */
function findPresent(p, text) {
  return p.kind === 'regex' ? p.regex.test(text) : text.includes(p.find);
}

/** 执行一次替换，返回 { text, replaced }。 */
function runReplace(p, text) {
  if (p.kind === 'regex') {
    if (!p.regex.test(text)) return { text, replaced: false };
    return { text: text.replace(p.regex, p.replace), replaced: true };
  }
  if (!text.includes(p.find)) return { text, replaced: false };
  return { text: text.replace(p.find, p.replace), replaced: true };
}

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
    const found = findPresent(p, text);
    let state;
    if (applied) state = 'applied';
    else if (found) state = 'pending';
    else state = 'missing';
    return { id: p.id, group: p.group, title: p.title, required: p.required, state };
  });
}

/** 把一段文本上所有补丁反向撤掉，得到"原版"。用于无备份还原与基线重建。 */
export function unpatchText(text) {
  let out = text;
  const undone = [];
  for (const p of PATCHES) {
    if (!p.unpatch || !p.isApplied(out)) continue;
    const r = p.unpatch(out);
    if (r.changed) {
      out = r.text;
      undone.push(p.id);
    }
  }
  return { text: out, undone };
}

/** 当前文本是否处于"补丁态"。 */
export function isPatched(text) {
  return PATCHES.some((p) => p.isApplied(text));
}

/**
 * 维护基线备份。
 *
 * ZCode 升级会直接覆盖 zcode.cjs：此时旧备份是上一代的文件，拿它 revert 会把新版引擎
 * 打回旧版 —— 那比不还原更糟。所以每次 apply 都校验一次备份是否与"当前这一代的原版"一致，
 * 不一致就重建。判断依据是 unpatch 后的内容，不依赖任何版本号。
 */
function refreshBaseline(enginePath, currentText) {
  const bak = backupPath(enginePath);
  const baseline = isPatched(currentText) ? unpatchText(currentText).text : currentText;

  // 只有确认是真正的原版才写：必须重新出现安全条款锚点
  if (!baseline.includes(SECURITY_NOTICE)) return { rebuilt: false, reason: '当前不是可识别的原版，保留旧备份' };

  let existing = null;
  try {
    existing = fs.readFileSync(bak, 'utf8');
  } catch {
    existing = null;
  }
  if (existing === baseline) return { rebuilt: false, reason: '备份已是最新' };

  fs.writeFileSync(bak, baseline, 'utf8');
  return { rebuilt: true, stale: existing !== null };
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
    if (!findPresent(p, text)) {
      results.push({ id: p.id, state: 'missing', reason: '锚点对不上（引擎版本不符）' });
      continue;
    }
    const before = text.length;
    const r = runReplace(p, text);
    if (!r.replaced) {
      results.push({ id: p.id, state: 'missing', reason: '锚点对不上（引擎版本不符）' });
      continue;
    }
    text = r.text;
    results.push({ id: p.id, state: 'patched', delta: text.length - before });
  }

  const changed = text !== original;
  if (!changed) return { changed: false, results, verified: true };

  // 先按需重建基线备份，再原子写，最后语法校验；校验失败立刻回滚，绝不留半残文件。
  const baseline = refreshBaseline(enginePath, original);

  // 临时文件必须保留 .cjs 扩展名，否则 node --check 不认扩展名会拒绝检查。
  const tmp = `${enginePath}.zcpurge-tmp.cjs`;
  fs.writeFileSync(tmp, text, 'utf8');
  const check = syntaxCheck(tmp);
  if (!check.ok) {
    fs.rmSync(tmp, { force: true });
    return { changed: false, results, verified: false, error: check.error };
  }
  fs.renameSync(tmp, enginePath);
  return { changed: true, results, verified: true, baseline };
}

/**
 * 还原。
 *
 * 优先走"反向补丁"：把注入槽和继承标记改回原样。这样 ZCode 升级过、备份已作废时
 * 也能安全还原到**当前这一代**的原版，而不是把新引擎打回旧版。
 * 只有在反向补丁不适用时才回落到备份文件。
 */
export function revert(enginePath) {
  const current = readEngine(enginePath);

  if (isPatched(current)) {
    const { text, undone } = unpatchText(current);
    if (!text.includes(SECURITY_NOTICE)) {
      return { changed: false, reason: '反向补丁失败：结果里没有原安全条款，已放弃写入' };
    }
    const tmp = `${enginePath}.zcpurge-tmp.cjs`;
    fs.writeFileSync(tmp, text, 'utf8');
    const check = syntaxCheck(tmp);
    if (!check.ok) {
      fs.rmSync(tmp, { force: true });
      return { changed: false, reason: `反向补丁后语法校验失败：${check.error}` };
    }
    fs.renameSync(tmp, enginePath);
    const bak = backupPath(enginePath);
    if (fs.existsSync(bak)) fs.rmSync(bak, { force: true });
    return { changed: true, verified: true, via: 'unpatch', undone };
  }

  const bak = backupPath(enginePath);
  if (!fs.existsSync(bak)) {
    return { changed: false, reason: '当前没有补丁痕迹，也没有备份，无需还原' };
  }
  // 走到这里说明引擎是原版但备份还在：备份可能是上一代残留，先确认它和当前一代一致再说
  const bakText = fs.readFileSync(bak, 'utf8');
  if (bakText !== current) {
    fs.rmSync(bak, { force: true });
    return { changed: false, reason: '备份与当前引擎不是同一代（ZCode 升级过），已丢弃过期备份；引擎本身已是原版' };
  }
  fs.rmSync(bak, { force: true });
  return { changed: false, reason: '引擎已是原版，已清理多余备份' };
}

export function hasBackup(enginePath) {
  return fs.existsSync(backupPath(enginePath));
}
