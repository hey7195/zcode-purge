// Dump a byte/char range of zcode.cjs as-is (chunks, for reading long template literals).
import fs from 'node:fs';
const FILE = process.argv[2];
const start = Number(process.argv[3]);
const len = Number(process.argv[4] || 20000);
const text = fs.readFileSync(FILE, 'utf8');
process.stdout.write(text.slice(start, start + len));
