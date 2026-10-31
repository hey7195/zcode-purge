// 适配验证：在当前引擎副本上跑 "反向补丁还原 → 重新打补丁" 往返。
// 全程在临时副本上，不碰真实安装。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as patch from "../lib/patch.mjs";

const REAL = process.argv[2] || "E:\\ZCode\\resources\\glm\\zcode.cjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zcpurge-adapt-"));
const engine = path.join(sandbox, "zcode.cjs");
fs.copyFileSync(REAL, engine);

// 刻意放一份"过期的旧备份"，模拟 ZCode 升级后备份还是上一代的情形
const bak = `${engine}.zcpurge.bak`;
fs.writeFileSync(bak, 'var STALE = "上一代备份";\n', "utf8");

const read = () => fs.readFileSync(engine, "utf8");
const patched = () => patch.isPatched(read());

check("起点是补丁态", patched());
check("起点含注入槽", read().includes("inject-slot.txt"));
check("起点无原安全条款", !read().includes(patch.SECURITY_NOTICE));
check("备份是过期内容", fs.readFileSync(bak, "utf8").includes("上一代备份"));

// 1. 反向补丁还原（不依赖备份）
const r1 = patch.revert(engine);
check("revert 走了反向补丁", r1.changed === true && r1.via === "unpatch", `undone=${r1.undone?.join(",") || "-"}`);
check("还原后语法合法", r1.verified === true, r1.reason || "");
check("还原后原安全条款回归", read().includes(patch.SECURITY_NOTICE));
check("还原后注入槽消失", !read().includes("inject-slot.txt"));
check("还原后 guarded 原逻辑回归", read().includes(patch.INHERIT_MODE_BODY));
check("还原后继承标记消失", !read().includes(patch.INHERIT_MODE_MARK));
check("过期备份已清理", !fs.existsSync(bak));

// 2. 重新打补丁（应重建一代正确的基线备份）
const r2 = patch.apply(engine);
check("重新打补丁成功", r2.verified === true, r2.error || "");
check("两个补丁都打上", r2.results.every((x) => x.state === "applied" || x.state === "patched"), JSON.stringify(r2.results.map((x) => `${x.id}:${x.state}`)));
check("备份已重建", r2.baseline?.rebuilt === true);
check("基线含原安全条款", fs.readFileSync(bak, "utf8").includes(patch.SECURITY_NOTICE));
check("基线不含注入槽（说明是真原版）", !fs.readFileSync(bak, "utf8").includes("inject-slot.txt"));

// 3. 幂等
const r3 = patch.apply(engine);
check("二次 apply 不重复改写", r3.changed === false);

// 4. 再还原一次，确认稳定
const r4 = patch.revert(engine);
check("再还原仍走反向补丁", r4.changed === true && r4.via === "unpatch");
const restored = read();
const bakText = fs.existsSync(`${engine}.zcpurge.bak`) ? fs.readFileSync(`${engine}.zcpurge.bak`, "utf8") : null;
check("还原结果与基线一致（若存在）", bakText === null || bakText === restored);

fs.rmSync(sandbox, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
