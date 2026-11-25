// 生成 ZCode 备份清单（manifest.json），记录版本、路径、关键文件哈希。
// 用法: node tools/write-backup-manifest.mjs <备份根> <安装源> <用户数据源>
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [backupRoot, installSrc, userDataSrc] = process.argv.slice(2);
if (!backupRoot) {
  console.error("用法: node write-backup-manifest.mjs <备份根> [安装源] [用户数据源]");
  process.exit(2);
}

function sha256(file) {
  try {
    const buf = fs.readFileSync(file);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function statOf(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files++;
        try {
          bytes += fs.statSync(p).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

const KEY_FILES = ["ZCode.exe", path.join("resources", "glm", "zcode.cjs"), path.join("resources", "app.asar")];

const installDir = path.join(backupRoot, "install");
const userDir = path.join(backupRoot, "userdata");

let version = null;
try {
  const exe = path.join(installDir, "ZCode.exe");
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Item '${exe}').VersionInfo.ProductVersion`], {
    encoding: "utf8",
  });
  version = out.trim();
} catch {
  version = null;
}

const manifest = {
  kind: "zcode-backup",
  createdAt: new Date().toISOString(),
  zcodeProductVersion: version || "unknown",
  source: { install: installSrc || null, userData: userDataSrc || null },
  backup: { install: installDir, userData: userDir },
  install: statOf(installDir),
  userData: statOf(userDir),
  keyFiles: Object.fromEntries(KEY_FILES.map((f) => [f, sha256(path.join(installDir, f))])),
  notes: [
    "install 是冷备：ZCode 进程退出后可完整还原。",
    "userdata 是热备：SQLite 可能被进程独占，回退数据库前建议先用 refresh-userdata.ps1 重备。",
    "回退见 RESTORE.ps1。",
  ],
};

const out = path.join(backupRoot, "manifest.json");
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`版本: ${manifest.zcodeProductVersion}`);
console.log(`安装: ${manifest.install.files} 文件 / ${(manifest.install.bytes / 1024 / 1024).toFixed(1)} MiB`);
console.log(`数据: ${manifest.userData.files} 文件 / ${(manifest.userData.bytes / 1024 / 1024).toFixed(1)} MiB`);
console.log(`清单: ${out}`);
