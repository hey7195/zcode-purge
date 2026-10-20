// Reconnaissance scanner for ZCode's bundled agent engine (zcode.cjs).
// Extracts keyword hit counts and small context windows so we can locate the
// system-prompt / permission-gate / hooking surfaces. Read-only.
// 用法: node tools/scan.mjs [引擎路径] [关键词,逗号分隔] [窗口]   （省略路径则自动探测安装）
import fs from 'node:fs';
import { findZCodeInstall } from '../lib/paths.mjs';

const FILE = process.argv[2] || findZCodeInstall()?.engine;
if (!FILE || !fs.existsSync(FILE)) {
  console.error('找不到 zcode.cjs：传路径参数，或设置 ZCODE_HOME');
  process.exit(2);
}
const WINDOW = Number(process.argv[4] || 220);
const keys = (process.argv[3] || 'systemPrompt,AGENTS.md').split(',');

const text = fs.readFileSync(FILE, 'utf8');
console.log(`# ${FILE}\n# size=${text.length} chars  lines=${text.split('\n').length}`);

for (const k of keys) {
  const hits = [];
  let i = -1;
  while ((i = text.indexOf(k, i + 1)) !== -1) {
    hits.push(i);
    if (hits.length > 4000) break;
  }
  console.log(`\n=== ${k} :: ${hits.length} hits ===`);
  for (const p of hits.slice(0, Number(process.env.MAXSHOW || 6))) {
    const s = Math.max(0, p - Math.floor(WINDOW / 2));
    const frag = text.slice(s, s + WINDOW).replace(/\s+/g, ' ');
    console.log(`  @${p}  …${frag}…`);
  }
}
