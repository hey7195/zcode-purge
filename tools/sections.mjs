// Enumerate system-prompt section definitions: name / source / injectionTarget triples.
import fs from 'node:fs';
const FILE = process.argv[2];
const text = fs.readFileSync(FILE, 'utf8');

const re = /name:"([^"]{1,60})",source:"([^"]{1,60})",injectionTarget:"([^"]{1,40})"/g;
const seen = new Map();
let m;
while ((m = re.exec(text))) {
  const key = `${m[1]} | ${m[2]} | ${m[3]}`;
  if (!seen.has(key)) seen.set(key, { offset: m.index, count: 0 });
  seen.get(key).count++;
}
console.log(`sections: ${seen.size}`);
for (const [k, v] of [...seen].sort((a, b) => a[1].offset - b[1].offset)) {
  console.log(`  @${String(v.offset).padStart(9)}  x${v.count}  ${k}`);
}
