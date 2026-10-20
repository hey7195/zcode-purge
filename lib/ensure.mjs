// 自动应用：让"装完就生效、升级后自愈"成立。
// 会话开始时调用：引擎未打补丁或引擎被 ZCode 升级覆盖 → 自动重打。
// 用引擎的 mtime+size 做缓存，避免每个会话都读 15 MB。
import fs from 'node:fs';
import path from 'node:path';
import { findZCodeInstall, purgeRoot } from './paths.mjs';
import * as patch from './patch.mjs';

function statePath() {
  return path.join(purgeRoot(), 'state.json');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(s) {
  try {
    fs.mkdirSync(purgeRoot(), { recursive: true });
    fs.writeFileSync(statePath(), `${JSON.stringify(s, null, 2)}\n`, 'utf8');
  } catch {
    /* 状态写不进去不影响主流程 */
  }
}

/**
 * 确保引擎处于已补丁状态。
 * @returns {{status:'applied'|'already'|'patched'|'no-install'|'error', detail?:string, engine?:string}}
 */
export function ensurePatched({ force = false } = {}) {
  const inst = findZCodeInstall();
  if (!inst) return { status: 'no-install' };

  let stat;
  try {
    stat = fs.statSync(inst.engine);
  } catch (err) {
    return { status: 'error', detail: String(err.message || err), engine: inst.engine };
  }

  const state = readState();
  const fingerprint = `${stat.mtimeMs}:${stat.size}`;
  if (!force && state.engine === inst.engine && state.fingerprint === fingerprint && state.patched === true) {
    return { status: 'already', engine: inst.engine };
  }

  try {
    const r = patch.apply(inst.engine, { includeOptional: true });
    if (!r.verified) {
      writeState({ ...state, engine: inst.engine, fingerprint, patched: false, error: r.error });
      return { status: 'error', detail: r.error, engine: inst.engine };
    }
    const applied = r.results.filter((x) => x.state === 'applied' || x.state === 'patched').length;
    const missing = r.results.filter((x) => x.state === 'missing');
    writeState({
      engine: inst.engine,
      fingerprint,
      patched: applied > 0,
      appliedAt: new Date().toISOString(),
      missing: missing.map((m) => m.id),
    });
    if (applied === 0 && missing.length > 0) {
      return { status: 'error', detail: `锚点不符：${missing.map((m) => m.id).join(', ')}`, engine: inst.engine };
    }
    return { status: r.changed ? 'patched' : 'already', engine: inst.engine };
  } catch (err) {
    return { status: 'error', detail: String(err.message || err), engine: inst.engine };
  }
}

export function readPurgeState() {
  return readState();
}
