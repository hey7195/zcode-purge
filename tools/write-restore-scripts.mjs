// 生成两个 PowerShell 脚本（带 BOM，Windows PowerShell 5.1 下中文才不乱码）。
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2] || "E:\\ZCode-backup\\3.17.1";
fs.mkdirSync(outDir, { recursive: true });

const RESTORE = String.raw`<#
.SYNOPSIS
  把 ZCode 回退到备份时的版本。

.DESCRIPTION
  默认只回退安装目录（程序本体）。加 -WithUserData 连用户数据一起回退。
  回退前要求 ZCode 完全退出；-Force 会强制结束进程。

.EXAMPLE
  .\RESTORE.ps1                    # 只回退程序
  .\RESTORE.ps1 -WithUserData      # 程序 + 配置/会话数据库
  .\RESTORE.ps1 -Force             # 不询问，自动结束 ZCode 进程
#>
param(
  [string]$Backup   = $PSScriptRoot,
  [string]$Target   = "E:\ZCode",
  [string]$UserData = "$env:USERPROFILE\.zcode",
  [switch]$WithUserData,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }

$manifestPath = Join-Path $Backup "manifest.json"
if (-not (Test-Path $manifestPath)) { Say "找不到备份清单: $manifestPath" Red; exit 1 }
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

Say "===================================================" Cyan
Say " ZCode 回退" Cyan
Say "===================================================" Cyan
Say " 备份版本 : $($manifest.zcodeProductVersion)"
Say " 备份时间 : $($manifest.createdAt)"
Say " 安装目录 : $Target"
if ($WithUserData) { Say " 用户数据 : $UserData" }
Say ""

# ── 1. ZCode 必须退出 ────────────────────────────────────────
$procs = @(Get-Process -Name ZCode, "pi-desktop-host-core" -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
  if ($Force) {
    Say "强制结束 $($procs.Count) 个进程…" Yellow
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
  } else {
    Say "ZCode 还在运行（$($procs.Count) 个进程）。" Red
    Say "请完全退出 ZCode（含托盘图标）后重跑，或加 -Force。" Yellow
    exit 1
  }
}

# ── 2. 确认 ────────────────────────────────────────────────
if (-not $Force) {
  Say "即将把 $Target 覆盖回 $($manifest.zcodeProductVersion)。" Yellow
  if ($WithUserData) { Say "并且覆盖用户数据目录 $UserData（配置、会话、数据库）。" Yellow }
  $ans = Read-Host "确认回退？输入 yes 继续"
  if ($ans -ne "yes") { Say "已取消。" Gray; exit 0 }
}

# ── 3. 回退安装目录 ────────────────────────────────────────
Say ""
Say "回退安装目录…" Cyan
$rc = (robocopy (Join-Path $Backup "install") $Target /MIR /R:1 /W:1 /MT:8 /NFL /NDL /NJH /NJS /NP)
if ($LASTEXITCODE -ge 8) {
  Say "robocopy 失败（退出码 $LASTEXITCODE）—— 可能有文件被占用。" Red
  Say "确认 ZCode 完全退出后重试。" Yellow
  exit 1
}

# ── 4. 可选：回退用户数据 ──────────────────────────────────
if ($WithUserData) {
  Say "回退用户数据…" Cyan
  robocopy (Join-Path $Backup "userdata") $UserData /MIR /R:1 /W:1 /MT:8 /NFL /NDL /NJH /NJS /NP /XJ | Out-Null
  if ($LASTEXITCODE -ge 8) { Say "用户数据回退有问题（退出码 $LASTEXITCODE），程序本体已回退。" Yellow }
}

# ── 5. 校验 ────────────────────────────────────────────────
Say ""
Say "校验关键文件…" Cyan
$ok = $true
foreach ($rel in @("ZCode.exe", "resources\glm\zcode.cjs", "resources\app.asar")) {
  $p = Join-Path $Target $rel
  if (-not (Test-Path $p)) { Say "  缺失: $rel" Red; $ok = $false; continue }
  $want = $manifest.keyFiles.$rel
  if (-not $want) { continue }
  $got = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
  if ($got -eq $want.ToLower()) {
    Say ("  一致: {0}" -f $rel) Green
  } else {
    Say ("  不一致: {0}" -f $rel) Red
    $ok = $false
  }
}

Say ""
if ($ok) {
  Say "回退完成。现在可以启动 ZCode（$($manifest.zcodeProductVersion)）。" Green
  Say "注意：如果之前装过 zcode-purge，补丁不在这份备份里，需要重新 apply。" Gray
} else {
  Say "回退完成但有校验失败项，见上面。" Yellow
}
`;

const REFRESH = String.raw`<#
.SYNOPSIS
  退出 ZCode 后重新备份用户数据（SQLite 冷备，保证一致）。

.DESCRIPTION
  安装目录可以热备，用户数据里的 tasks-index.sqlite 会被进程独占，
  热备出来的副本不保证一致。先完全退出 ZCode，再跑这个脚本。

.EXAMPLE
  .\refresh-userdata.ps1
#>
param(
  [string]$Backup   = $PSScriptRoot,
  [string]$UserData = "$env:USERPROFILE\.zcode"
)

$ErrorActionPreference = "Stop"
function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }

$procs = @(Get-Process -Name ZCode -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
  Say "ZCode 还在运行（$($procs.Count) 个进程）。" Red
  Say "请完全退出（含托盘）后重跑本脚本 —— 数据库要求冷备。" Yellow
  exit 1
}

Say "重新备份用户数据（冷备）…" Cyan
$dest = Join-Path $Backup "userdata"
robocopy $UserData $dest /MIR /R:1 /W:1 /MT:8 /NFL /NDL /NJH /NJS /NP /XJ | Out-Null
if ($LASTEXITCODE -ge 8) { Say "robocopy 退出码 $LASTEXITCODE，可能有文件读不了。" Red; exit 1 }

# 一致性抽查：源与备份的主库哈希应一致（此时没有进程在写）
$db = Join-Path $UserData "v2\tasks-index.sqlite"
$dbBak = Join-Path $dest "v2\tasks-index.sqlite"
if ((Test-Path $db) -and (Test-Path $dbBak)) {
  $same = (Get-FileHash $db).Hash -eq (Get-FileHash $dbBak).Hash
  if ($same) { Say "数据库一致 ✓（冷备成功）" Green } else { Say "数据库哈希仍不一致，请确认进程已全部退出。" Yellow }
}

Say "完成。备份目录: $dest" Green
`;

function writeWithBom(file, content) {
  fs.writeFileSync(file, `\uFEFF${content}`, "utf8");
}

writeWithBom(path.join(outDir, "RESTORE.ps1"), RESTORE);
writeWithBom(path.join(outDir, "refresh-userdata.ps1"), REFRESH);

for (const f of ["RESTORE.ps1", "refresh-userdata.ps1"]) {
  const p = path.join(outDir, f);
  console.log(`${f}  ${(fs.statSync(p).size / 1024).toFixed(1)} KiB`);
}
