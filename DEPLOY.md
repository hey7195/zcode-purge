# 部署文档

从零到跑通，照着做。每一步都能独立验证，出问题看第 8 节。

---

## 0. 30 秒版

确认装了 [ZCode](https://z.ai)（3.15.x）和 Node.js ≥ 18，然后：

```bash
git clone https://github.com/hey7195/zcode-purge.git zcode-purge
cd zcode-purge
node bin/zcode-purge.mjs install
node bin/zcode-purge.mjs proof
```

`install` 走 ZCode 官方插件机制，`proof` 全 PASS 就是成功了。
之后**完全退出 ZCode 再启动**，让引擎补丁进新进程。

要移除：

```bash
node bin/zcode-purge.mjs uninstall
```

---

## 1. 前置条件

| 项 | 要求 | 怎么确认 |
|---|---|---|
| ZCode | 3.15.x（Electron 桌面端） | 客户端「关于」；或安装目录下有 `resources/glm/zcode.cjs` |
| Node.js | ≥ 18（推荐 22+） | `node --version` |
| 磁盘 | 能改 ZCode 安装目录 | 安装时会写 `resources/glm/zcode.cjs` |
| 权限 | 管理员（若 ZCode 装在 Program Files） | 装不上时看第 8 节 |

**不需要**：翻墙、API key、管理员以外的东西。全过程不联网（`install` 只调用本机 ZCode CLI）。

ZCode 装在非默认位置也能用，本工具自己探测：

1. 环境变量 `ZCODE_HOME`
2. 注册表 `InstallLocation`
3. `%LOCALAPPDATA%\Programs\ZCode` / `%ProgramFiles%\ZCode`
4. 盘符根目录扫描（`C:\ZCode`、`D:\Zcode` …）

探测不到会报错并提示你设 `ZCODE_HOME`：

```powershell
$env:ZCODE_HOME = "D:\Your\ZCode"     # 指向含 resources\glm\zcode.cjs 的那一层
```

---

## 2. 部署

三条路，选一条。**推荐方式 A**。

### 方式 A：装成 ZCode 原生插件（推荐）

```bash
node bin/zcode-purge.mjs install
```

它做了五件事：

1. 生成 `~/.zcode/purge/`（注入词、开关、运行时副本）
2. `zcode plugins marketplace add <本仓库路径>` → 注册本地市场 `zcode-purge-local`
3. `zcode plugins install zcode-purge@zcode-purge-local` → 装成插件
4. 清掉以前手工写入 `config.json` 的 hooks（避免和插件 hooks 重复触发）
5. 给引擎打补丁 + 语法校验

**为什么推荐**：卸载走 `zcode plugins uninstall`，装/卸对称；插件 hook 自动启用，不用改用户配置；
每次会话开头 `SessionStart` 会自动检查并重打补丁 —— ZCode 升级覆盖后**自愈**。

装完在 ZCode 里能看到：

```
设置 → 插件管理 → zcode-purge [enabled]
  skills: 1, commands: 1, hooks: 2
```

### 方式 B：手工 hooks（不装插件）

```bash
node bin/zcode-purge.mjs apply --with-hooks
```

补丁进引擎，hooks 写进 `~/.zcode/cli/config.json` 的 `hooks` 键（`hooks.enabled: true`）。
没有自愈，ZCode 升级后要手动 `apply`。

### 方式 C：只改引擎（零 hook、零配置）

```bash
node bin/zcode-purge.mjs apply
```

只有提示词层和审批层生效，没有 hook 注入，也没有工具自动放行。
升级后会失效，需要重新 `apply`。

### 装完必须做的一步

**完全退出 ZCode 再启动。**

引擎补丁是文件级替换，旧进程内存里还是旧代码，必须重启才生效。
注入槽不用重启（运行时读文件），但第一次部署建议一起重启。

---

## 3. 验证生效

### 一条命令：`proof`

```bash
node bin/zcode-purge.mjs proof
```

先起一个**本地假 provider** 让 ZCode CLI 真跑一轮，把模型请求截下来——
不联网、不消耗真实 token，10–30 秒；顺带刷新启动日志，让挂钟数（hookCount）是最新的。
随后一次性给出两块结果。期望输出：

```
[PASS] 安全条款已替换          提示词层
[PASS] guarded 不再吞 yolo     审批层
[PASS] 插件已启用              注入层
[PASS] 运行时已识别 hook        注入层 · 日志 hookCount=2
[PASS] 注入槽非空              注入层 · 552 字符

[PASS] 系统提示词里的安全条款已消失
[PASS] 注入槽进了 system 段
[PASS] 身份段仍在（没有整体跳过）
[PASS] 用户消息正常下发
[PASS] hook 注入进了消息流
```

只想快速看一眼：`proof --no-probe`（只跑前 5 项）。

### 一个窗口：`panel`

```bash
node bin/zcode-purge.mjs panel
# → http://127.0.0.1:17871/
```

浏览器里是控制台：结论横幅、逐层证据表、运行时明细（插件路径 / hookCount / 槽字数 / 备份）、
五个按钮（打补丁 / 同步注入词 / 抓请求验证 / 还原 / 完全移除）、注入词编辑器、system 段实测预览。

只监听 `127.0.0.1`。换端口：`panel --port=17900`；不自动开浏览器：`panel --no-open`。

### 手动查

| 看什么 | 怎么看 |
|---|---|
| 引擎补丁 | `node bin/zcode-purge.mjs status` → 补丁「已生效」 |
| hook 注册 | `~/.zcode/cli/log/zcode-*.jsonl` 搜 `plugins.completed`，看 `"hookCount":2` |
| 插件状态 | `zcode plugins list`（需 `ELECTRON_RUN_AS_NODE=1` 调 `ZCode.exe`，或直接看客户端） |
| 最朴素 | 新开会话问一句原本会被拒的，看还会不会追加"仅限授权测试"之类收尾 |

---

## 4. 日常运维

### 改注入词（不用重打补丁）

```bash
# 1. 编辑
notepad %USERPROFILE%\.zcode\purge\prompt-inject.md

# 2. 同步进槽
node bin/zcode-purge.mjs prompt --sync

# 3. 新开会话即生效（系统提示词段想立刻换就重启 ZCode）
```

### 开关

`~/.zcode/purge/config.json`：

```json
{
  "sessionStartInject": true,   // 会话开头注入破甲槽
  "userPromptInject": false,    // 每轮追加抗漂移提醒（费 token，默认关）
  "autoApprove": true,          // PreToolUse 全放行工具（想留确认改 false）
  "autoApply": true             // 会话开头自愈引擎补丁（关掉就靠手动 apply）
}
```

改完立刻生效，不用重启进程、不用重打补丁。

### ZCode 升级之后

不用管。下次开新会话时 `SessionStart` hook 会对比引擎指纹，发现被覆盖就自动重打。
手动确认：

```bash
node bin/zcode-purge.mjs proof --no-probe
```

要立刻生效而不等新会话：`node bin/zcode-purge.mjs apply`，然后重启 ZCode。

### 权限模式

`guarded` 模式会覆盖 hook 的 `allow`（宿主设计）。用 `yolo` / `build` / `edit`。

---

## 5. 移除

```bash
node bin/zcode-purge.mjs uninstall
```

按顺序做：还原引擎（用 `.zcpurge.bak`）→ 卸插件 → 移市场 → 清残留目录 → 删 `~/.zcode/purge`。

保留注入词：`uninstall --keep-data`。

**然后重启 ZCode**，让进程回到原版引擎。

验证清干净了：

```bash
node tools/verify-restored.mjs
```

八项全 PASS 就是完全还原：

```
PASS  安全条款已回归原版
PASS  注入槽读取器已消失
PASS  guarded 原逻辑已回归
PASS  备份文件已清理
PASS  临时文件未残留
PASS  用户 purge 目录已删
PASS  插件 cache 已删
PASS  marketplace 目录已删
```

---

## 6. 移植到新机器

整个目录拷过去就行（不含 `node_modules`，本来也没有）：

```bash
# 新机器上
cd zcode-purge
node bin/zcode-purge.mjs install
node bin/zcode-purge.mjs proof
```

不写死盘符、不写死 node 路径：

- ZCode 安装位置：环境变量 → 注册表 → 常见目录 → 盘符扫描
- Node 路径：取当前进程 `process.execPath`
- 插件里引用自身：`${CLAUDE_PLUGIN_ROOT}`

跨平台：Node 和 ZCode 都是跨平台的，脚本里没有平台相关命令（`install`/`uninstall` 调的是 ZCode 自己的 CLI，
它会自己处理路径）。Windows 已验证；macOS / Linux 下 ZCode 若放在 `ZCode.app` 或 `/opt`，
把 `ZCODE_HOME` 指过去即可。

---

## 7. 从源码仓库直接可用

不需要 build，没有依赖，不需要 `npm install`：

```
node bin/zcode-purge.mjs <命令>
```

`~/.zcode/purge/bin/zcode-purge.mjs` 是 `install` 时复制的运行时副本，
和仓库里的是同一份代码，路径更短、更稳定，适合写进脚本或斜杠命令。

---

## 8. 故障排查

| 症状 | 原因 | 怎么修 |
|---|---|---|
| `找不到 ZCode 安装` | 探测不到 | 设 `ZCODE_HOME` 指向含 `resources\glm\zcode.cjs` 的目录 |
| `install` 里 `plugins install` fail | ZCode CLI 起不来 | 手动确认：`$env:ELECTRON_RUN_AS_NODE=1; & "路径\ZCode.exe" "路径\resources\glm\zcode.cjs" plugins list` |
| 补丁「跳过（锚点不符）」 | ZCode 改了文案 | `revert` 还原，等锚点更新，**不要手改引擎** |
| 补丁已生效但没变化 | 没重启 ZCode | 完全退出（含托盘）再启动 |
| `proof` 里 system 段没注入 | 注入槽空 / 关了开关 | `prompt --sync`；检查 `config.json` 的 `sessionStartInject` |
| `hookCount` 一直是 0 | 插件没启用 | `zcode plugins enable zcode-purge`，或客户端里手动启用 |
| hook 报 `MODULE_NOT_FOUND` | 只装了脚本没装 lib | `zcode-purge install` 会一起部署；手工模式也覆盖了这个 |
| `panel` 打不开 | 端口占用 | `panel --port=17900` |
| 卸载后还有残留 | ZCode 卸插件不清磁盘副本 | 新版 `uninstall` 已补清理；老版手动删 `~/.zcode/cli/plugins/{cache,marketplaces}/zcode-purge-local` |
| 模型仍然拒绝 | 服务端或模型层策略 | 本地这三层已经到底，见第 9 节「边界」 |

---

## 9. 原理速查

三层，全部可还原：

| 层 | 做了什么 | 落点 |
|---|---|---|
| 提示词层 | system prompt 里那条安全条款 → 运行时读文件的表达式 | `resources/glm/zcode.cjs` |
| 审批层 | `guarded` 不再把 `yolo` 拉回 | 同上 |
| 注入层 | `SessionStart` 注入 + 自愈；`PreToolUse` 放行工具 | 插件 `hooks/hooks.json` |

锚点（ZCode 3.15.x，`zcode.cjs` 里各出现一次）：

```js
// 提示词层：Agent Identity 段的安全条款
Ydo="IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, ...
     Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain
     compromise, or detection evasion for malicious purposes. ..."

// 审批层：guarded 会话里请求 yolo 会被拽回 guarded
function cnn(e,t){return e==="guarded"&&t==="yolo"?"guarded":t}
```

### 边界

1. **服务端提示词管不了。** 只清洗本地这一层。中转站或官方端点若在自己的 system 里叠策略，本地无效。
   判断方法：`proof` 抓到的请求体里，`system` 数组有没有非本客户端的内容。
2. **`guarded` 会覆盖 hook 的 allow**（宿主设计）。
3. **补丁按字面量匹配。** ZCode 改文案后锚点失配，行为是"跳过"而不是乱改。
4. **只动本机。** 不联网、不扫描外部目标。

---

## 附录 A：命令全表

```bash
node bin/zcode-purge.mjs <命令>

install                 一键部署（运行时副本 + 市场 + 插件 + 补丁）
install --no-plugin     只做手工部署
install --project       装到 project 作用域
uninstall               一键移除（还原 + 卸插件 + 清市场 + 删数据）
uninstall --keep-data   移除但保留 ~/.zcode/purge
deploy                  只同步运行时副本与注入槽
proof                   验生效（静态 + 真实请求抓取）
proof --no-probe        只跑静态检查
panel                   本地网页控制台
status                  补丁 / hooks / 注入槽 / 插件 / 运行时副本
apply [--with-hooks]    打补丁（--with-hooks 走手工模式）
apply --no-optional     只打必需补丁
revert                  用备份还原引擎
verify                  语法 / 槽 / hooks 自检
prompt [--sync]         注入词路径 / 写进注入槽
hooks install|remove    手工 hook 的装卸
help                    帮助
```

环境变量：`ZCODE_HOME`（安装根）、`ZCODE_USER_HOME`（用户数据根，默认 `~/.zcode`）。

在 ZCode 会话里也能用：`/purge status|apply|revert|verify|uninstall`。

## 附录 B：文件位置

| 东西 | 路径 |
|---|---|
| 引擎（被补丁的） | `<ZCode>/resources/glm/zcode.cjs` |
| 引擎备份 | 同上 + `.zcpurge.bak` |
| 注入词 | `~/.zcode/purge/prompt-inject.md` |
| 注入槽 | `~/.zcode/purge/inject-slot.txt` |
| 开关 | `~/.zcode/purge/config.json` |
| 自愈指纹 | `~/.zcode/purge/state.json` |
| 运行时副本 | `~/.zcode/purge/bin|lib|scripts/` |
| 手工 hooks | `~/.zcode/cli/config.json` → `hooks` |
| 插件 cache | `~/.zcode/cli/plugins/cache/zcode-purge-local/` |
| 本地市场 | `~/.zcode/cli/plugins/marketplaces/zcode-purge-local/` |
| ZCode 日志 | `~/.zcode/cli/log/zcode-*.jsonl` |
