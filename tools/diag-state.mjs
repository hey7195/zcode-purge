// 诊断：selfheal 之后引擎到底处于什么状态，为什么 inherit 补丁 missing。
import fs from "node:fs";
import * as patch from "../lib/patch.mjs";

const eng = process.argv[2] || "E:\\ZCode\\resources\\glm\\zcode.cjs";
const text = fs.readFileSync(eng, "utf8");

console.log("=== 引擎现状 ===");
console.log("字符数:", text.length);
console.log("含原安全条款:", text.includes(patch.SECURITY_NOTICE));
console.log("含注入槽读取器:", text.includes("inject-slot.txt"));
console.log("含继承标记:", text.includes(patch.INHERIT_MODE_MARK));
console.log("isPatched():", patch.isPatched(text));

console.log("\n=== inspect() 各补丁状态 ===");
for (const p of patch.inspect(eng)) console.log(` ${p.id.padEnd(24)} ${p.state}`);

console.log("\n=== inherit 锚点匹配情况 ===");
console.log("INHERIT_MODE_REGEX 命中:", patch.INHERIT_MODE_REGEX.test(text));
const body = patch.INHERIT_MODE_BODY;
console.log("函数体字面量命中:", text.includes(body));

// 打印实际出现的那段代码
const idx = text.indexOf('e==="guarded"');
if (idx >= 0) {
  console.log("实际片段:", JSON.stringify(text.slice(idx - 60, idx + 60)));
} else {
  console.log("没找到 e===\"guarded\" 字样");
}

console.log("\n=== 备份 ===");
const bak = `${eng}.zcpurge.bak`;
if (fs.existsSync(bak)) {
  const b = fs.readFileSync(bak, "utf8");
  console.log("存在 | 字符数:", b.length, "| 含安全条款:", b.includes(patch.SECURITY_NOTICE), "| 含注入槽:", b.includes("inject-slot.txt"));
} else {
  console.log("不存在");
}
