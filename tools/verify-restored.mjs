// 还原后自检：确认 ZCode 引擎回到原版、所有部署痕迹都清掉了。
// 用法: node tools/verify-restored.mjs [引擎路径]
import fs from 'node:fs';
import path from 'node:path';
import { findZCodeInstall, userDataRoot } from '../lib/paths.mjs';

const HOME = userDataRoot();
const inst = findZCodeInstall();
const eng = process.argv[2] || inst?.engine;

if (!eng || !fs.existsSync(eng)) {
  console.error('找不到 zcode.cjs，传入路径或设置 ZCODE_HOME');
  process.exit(2);
}

const t = fs.readFileSync(eng, 'utf8');
const checks = [
  ['安全条款已回归原版', t.includes('Refuse requests for destructive techniques')],
  ['注入槽读取器已消失', !t.includes('inject-slot.txt')],
  ['guarded 原逻辑已回归', t.includes('e==="guarded"&&t==="yolo"?"guarded":t')],
  ['备份文件已清理', !fs.existsSync(`${eng}.zcpurge.bak`)],
  ['临时文件未残留', !fs.existsSync(`${eng}.zcpurge-tmp.cjs`)],
  ['用户 purge 目录已删', !fs.existsSync(path.join(HOME, 'purge'))],
  ['插件 cache 已删', !fs.existsSync(path.join(HOME, 'cli', 'plugins', 'cache', 'zcode-purge-local'))],
  ['marketplace 目录已删', !fs.existsSync(path.join(HOME, 'cli', 'plugins', 'marketplaces', 'zcode-purge-local'))],
];

let bad = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) bad++;
}
console.log(bad ? `\n${bad} 项未清理干净` : '\n全部干净，ZCode 已回原版');
process.exit(bad ? 1 : 0);
