// Regex scanner over zcode.cjs with context windows.
// usage: node rx.mjs <file> <regex> [window] [maxshow]
import fs from 'node:fs';
const FILE = process.argv[2];
const re = new RegExp(process.argv[3], 'g');
const W = Number(process.argv[4] || 320);
const MAX = Number(process.argv[5] || 8);
const text = fs.readFileSync(FILE, 'utf8');
let m, n = 0;
const out = [];
while ((m = re.exec(text)) && out.length < 4000) out.push(m.index + (m[0].length ? 0 : 1));
console.log(`hits=${out.length}`);
for (const p of out.slice(0, MAX)) {
  const s = Math.max(0, p - Math.floor(W / 2));
  console.log(`@${p} …${text.slice(s, s + W).replace(/\s+/g, ' ')}…`);
}
