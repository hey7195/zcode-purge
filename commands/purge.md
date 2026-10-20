---
description: 管理 ZCode 破甲（zcode-purge）：查看状态、应用、还原、卸载、改注入词。
argument-hint: "[status|apply|revert|uninstall|prompt|verify]"
---

用户请求：`$ARGUMENTS`

按下面的方式执行（这是本机工具，改动都发生在用户自己的 ZCode 安装上，可还原）。

## 命令位置

运行时副本在用户目录，**不要**用插件 cache 里的路径：

- CLI：`~/.zcode/purge/bin/zcode-purge.mjs`（Windows: `%USERPROFILE%\.zcode\purge\bin\zcode-purge.mjs`）
- 注入词：`~/.zcode/purge/prompt-inject.md`
- 开关：`~/.zcode/purge/config.json`

用 Node 直接跑它，例如：

```powershell
node "$env:USERPROFILE\.zcode\purge\bin\zcode-purge.mjs" status
```

```bash
node ~/.zcode/purge/bin/zcode-purge.mjs status
```

## 动作映射

| `$ARGUMENTS` | 执行 |
|---|---|
| 空 / `status` | `... status` —— 报告补丁、hooks、注入槽、备份状态 |
| `apply` | `... apply` —— 同步注入槽并打补丁（已生效则跳过） |
| `revert` | `... revert` —— 用 `.zcpurge.bak` 还原引擎，删备份 |
| `verify` | `... verify` —— 语法 / 槽 / hooks 自检 |
| `prompt` | 打印注入词路径；改完跑 `... prompt --sync` |
| `uninstall` | `... uninstall` —— 还原 + 卸插件 + 清理，全量移除 |

## 汇报规则

- 跑完把关键行贴出来（补丁状态、hooks、注入槽字符数），别复述整份 README。
- 如果 `status` 显示"跳过（锚点不符）"，说明 ZCode 版本变了文案：报告出来，建议 `revert` 后等待插件更新，不要手改引擎。
- 如果补丁刚应用，提醒一次：**完全退出 ZCode 再启动**才进新进程。
- 不要自行修改 `prompt-inject.md` 的内容，除非用户明确要改。改完必须 `prompt --sync`。
