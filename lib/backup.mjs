// 升级前备份：把当前 ZCode 安装与用户数据整体快照下来，并生成回退脚本。
// 顺序很重要——先 revert 补丁，备份的才是官方原版。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { findZCodeInstall, userDataRoot } from "./paths.mjs";
import * as patch from "./patch.mjs";

const KEY_FILES = ["ZCode.exe", path.join("resources", "glm", "zcode.cjs"), path.join("resources", "app.asar")];

function sha256(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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
          /* 忽略读不到的文件 */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

function robocopy(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const args = [src, dst, "/MIR", "/R:1", "/W:1", "/MT:8", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/XJ"];
  try {
    execFileSync("robocopy", args, { windowsHide: true });
    return { ok: true, code: 0 };
  } catch (err) {
    const code = typeof err.status === "number" ? err.status : 16;
    return { ok: code < 8, code };
  }
}

function productVersion(installDir) {
  const exe = path.join(installDir, "ZCode.exe");
  if (!fs.existsSync(exe)) return "unknown";
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-Item '${exe}').VersionInfo.ProductVersion`],
      { encoding: "utf8", windowsHide: true }
    ).trim();
  } catch {
    return "unknown";
  }
}

/**
 * @param {{ dir?: string, keepPatches?: boolean }} opts
 * @returns {{ backupRoot:string, version:string, install:object, userData:object, revert:object|null, files:string[] }}
 */
export function backup({ dir, keepPatches = false } = {}) {
  const inst = findZCodeInstall();
  if (!inst) throw new Error("找不到 ZCode 安装");
  const userData = userDataRoot();

  // 先还原补丁，备份的才是官方原版
  let revertInfo = null;
  if (!keepPatches) {
    const r = patch.revert(inst.engine);
    revertInfo = { changed: r.changed, via: r.via, reason: r.reason };
  }

  const version = productVersion(inst.root);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = dir || path.join(path.dirname(inst.root), "ZCode-backup");
  const backupRoot = path.join(base, `${version}-${stamp}`);

  const installDst = path.join(backupRoot, "install");
  const userDst = path.join(backupRoot, "userdata");

  const rcInstall = robocopy(inst.root, installDst);
  const rcUser = robocopy(userData, userDst);

  // 关键文件哈希：备份后立刻与源比对，证明这份备份能还原
  const keyFiles = {};
  const verified = {};
  for (const rel of KEY_FILES) {
    const fromBackup = sha256(path.join(installDst, rel));
    keyFiles[rel] = fromBackup;
    const fromSource = sha256(path.join(inst.root, rel));
    verified[rel] = fromBackup !== null && fromBackup === fromSource;
  }

  const manifest = {
    kind: "zcode-backup",
    createdAt: new Date().toISOString(),
    zcodeProductVersion: version,
    source: { install: inst.root, userData },
    backup: { install: installDst, userData: userDst },
    install: statOf(installDst),
    userData: statOf(userDst),
    keyFiles,
    verified,
    patchesReverted: revertInfo,
    notes: [
      "install 为冷备，ZCode 退出后可完整还原。",
      "userdata 为热备；tasks-index.sqlite 可能被进程独占，回退数据库前先跑 refresh-userdata.ps1 重备。",
      "回退执行 RESTORE.ps1；加 -WithUserData 连配置与数据库一起回。",
    ],
  };
  fs.writeFileSync(path.join(backupRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    backupRoot,
    version,
    install: { ...manifest.install, ok: rcInstall.ok, code: rcInstall.code },
    userData: { ...manifest.userData, ok: rcUser.ok, code: rcUser.code },
    revert: revertInfo,
    verified,
  };
}
