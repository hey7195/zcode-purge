import fs from 'node:fs';
import { DEFAULT_PROMPT } from '../lib/prompt.mjs';

const md = fs.readFileSync(process.argv[2], 'utf8');
console.log('文件字节:', Buffer.byteLength(md));
console.log('与默认文本完全一致:', md.trim() === DEFAULT_PROMPT.trim());
