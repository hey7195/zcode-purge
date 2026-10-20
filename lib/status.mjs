// 统一状态采集：CLI status、proof、网页面板共用同一份事实来源。
import fs from 'node:fs';
import path from 'node:path';
import { findZCodeInstall, purgeRoot, promptInjectPath, userDataRoot } from './paths.mjs';
import * as patch from './patch.mjs';
import * as hooks from './hooks.mjs';
import * as installer from './installer.mjs';
import { readPurgeState } from './ensure.mjs';

function readPurgeConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(purgeRoot(), 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** 从最近一天的 ZCode 日志里读"已注册 hook 数"，这是 hook 真的进了运行时的硬证据。 */
export function logHookInfo() {
  const dir = path.join(userDataRoot(), 'cli', 'log');
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('zcode-') && f.endsWith('.jsonl'))
      .sort();
  } catch {
    return { available: false };
  }
  if (files.length === 0) return { available: false };

  const file = path.join(dir, files[files.length - 1]);
  let hookCount = null;
  let ts = null;
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.includes('plugins.completed')) continue;
      try {
        const j = JSON.parse(line);
        if (typeof j.context?.hookCount === 'number') {
          hookCount = j.context.hookCount;
          ts = j.timestamp;
        }
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    return { available: false };
  }
  return { available: true, file, hookCount, timestamp: ts };
}

export function collect() {
  const inst = findZCodeInstall();
  const patches = inst ? patch.inspect(inst.engine) : [];
  const h = hooks.status();
  const p = installer.pluginStatus();
  const rt = installer.installStatus();
  const slot = (() => {
    try {
      return fs.readFileSync(path.join(purgeRoot(), 'inject-slot.txt'), 'utf8').trim();
    } catch {
      return '';
    }
  })();

  return {
    install: inst ? { root: inst.root, engine: inst.engine } : null,
    patches,
    backup: inst ? patch.hasBackup(inst.engine) : false,
    engineReady: patches.length > 0 && patches.filter((x) => x.required).every((x) => x.state === 'applied'),
    hooksManual: h,
    plugin: p,
    runtime: rt,
    slot: { chars: slot.length, preview: slot.split('\n').slice(0, 3).join('\n') },
    config: readPurgeConfig(),
    purgeState: readPurgeState(),
    log: logHookInfo(),
    promptPath: promptInjectPath(),
  };
}

/** 一句话总结：现在到底算不算"生效"。 */
export function verdict(s) {
  const rows = [];
  rows.push({
    layer: '提示词层',
    name: '安全条款已替换',
    ok: s.patches.find((p) => p.id === 'security_notice')?.state === 'applied',
    detail: '引擎 system prompt 里那条 IMPORTANT ... Refuse ...',
  });
  rows.push({
    layer: '审批层',
    name: 'guarded 不再吞 yolo',
    ok: s.patches.find((p) => p.id === 'inherit_permission_mode')?.state === 'applied',
    detail: '可选补丁',
  });
  rows.push({
    layer: '注入层',
    name: '插件已启用',
    ok: !!(s.plugin.installed && s.plugin.enabled),
    detail: s.plugin.path || '',
  });
  rows.push({
    layer: '注入层',
    name: '运行时已识别 hook',
    // 日志里最后一次插件解析记录的 hookCount。没有日志时不算失败（判据不可得）。
    ok: s.log.available ? (s.log.hookCount ?? 0) >= 2 : true,
    detail: s.log.available
      ? `日志 hookCount=${s.log.hookCount}${(s.log.hookCount ?? 0) < 2 ? '（重启 ZCode 后应为 2）' : ''}`
      : '无日志，跳过',
  });
  rows.push({
    layer: '注入层',
    name: '注入槽非空',
    ok: s.slot.chars > 0,
    detail: `${s.slot.chars} 字符`,
  });
  const allOk = rows.every((r) => r.ok);
  return { rows, allOk };
}
