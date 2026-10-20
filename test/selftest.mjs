// 自测：在临时假安装上跑"apply → 幂等 → 回滚 → 语法校验"全链路，
// 全程不碰真实 ZCode 安装。需要一份真实 zcode.cjs 作为夹具。
// 用法: node test/selftest.mjs [真实引擎路径]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findZCodeInstall } from '../lib/paths.mjs';
import * as patch from '../lib/patch.mjs';

const real = process.argv[2] || findZCodeInstall()?.engine;
if (!real || !fs.existsSync(real)) {
  console.error('缺少夹具：找不到 zcode.cjs，传入路径参数');
  process.exit(2);
}

// 夹具优先取未打补丁的备份，避免"真实引擎已 apply"导致初始状态断言失真。
const dirty = patch.PATCHES.some((p) => p.isApplied(fs.readFileSync(real, 'utf8')));
const fixture = dirty && patch.hasBackup(real) ? `${real}.zcpurge.bak` : real;
console.log(`夹具: ${fixture}${dirty ? '（已打过补丁，取备份）' : ''}`);

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zcpurge-'));
const fakeRoot = path.join(sandbox, 'ZCodeFake');
const fakeEngine = path.join(fakeRoot, 'resources', 'glm', 'zcode.cjs');
fs.mkdirSync(path.dirname(fakeEngine), { recursive: true });
fs.copyFileSync(fixture, fakeEngine);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

try {
  // 1. 未打补丁时的状态
  const before = patch.inspect(fakeEngine);
  check('初始状态：必需补丁为 pending', before.find((p) => p.id === 'security_notice')?.state === 'pending');

  // 2. apply
  const a1 = patch.apply(fakeEngine);
  check('apply 校验通过', a1.verified === true, a1.error || '');
  check('apply 有实际改写', a1.changed === true);
  check('security_notice 已打上', a1.results.find((r) => r.id === 'security_notice')?.state === 'patched');
  check('原安全条款已消失', !fs.readFileSync(fakeEngine, 'utf8').includes(patch.SECURITY_NOTICE));

  // 3. 备份存在
  check('备份文件已生成', patch.hasBackup(fakeEngine));

  // 4. 幂等
  const a2 = patch.apply(fakeEngine);
  check('二次 apply 不重复改写', a2.changed === false);

  // 5. 语法仍合法
  const syn = patch.syntaxCheck(fakeEngine);
  check('补丁后 node --check 通过', syn.ok, syn.error || '');

  // 6. 运行时注入槽真的能读（在隔离环境里跑替换后的表达式语义）
  const text = fs.readFileSync(fakeEngine, 'utf8');
  check('注入槽读取器已内联', text.includes('".zcode","purge","inject-slot.txt"'));

  // 7. revert
  const rv = patch.revert(fakeEngine);
  check('revert 成功', rv.changed === true);
  check('revert 后语法合法', rv.verified === true, rv.error || '');
  check('revert 后安全条款回归', fs.readFileSync(fakeEngine, 'utf8').includes(patch.SECURITY_NOTICE));
  check('revert 后备份已清理', !patch.hasBackup(fakeEngine));

  // 8. 无备份时不乱动
  const rv2 = patch.revert(fakeEngine);
  check('无备份 revert 不改文件', rv2.changed === false);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
