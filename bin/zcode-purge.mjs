#!/usr/bin/env node
// zcode-purge —— 参考 dsh-purge 的思路，为 ZCode（智谱 AI 编程客户端）实现的三层解绑：
//   提示词层：系统提示词里的安全条款 → 运行时注入槽
//   审批层  ：guarded 不再吞掉 yolo
//   注入层  ：SessionStart / PreToolUse hook 走官方扩展点
// 三种用法：
//   1. 装成 ZCode 原生插件（推荐，装/移都走 zcode plugins）: zcode-purge install
//   2. 只用手工 hooks（不装插件）: zcode-purge apply --with-hooks
//   3. 完全不装（拷目录即用）: node bin/zcode-purge.mjs status
// 所有改动可回滚，原文件备份为 *.zcpurge.bak。
import process from 'node:process';
import fs from 'node:fs';
import { findZCodeInstall, promptInjectPath, purgeRoot, userDataRoot } from '../lib/paths.mjs';
import * as patch from '../lib/patch.mjs';
import * as hooks from '../lib/hooks.mjs';
import * as installer from '../lib/installer.mjs';
import * as statusLib from '../lib/status.mjs';
import { runProbe } from '../lib/probe.mjs';
import { startPanel } from '../lib/panel.mjs';
import { ensurePromptFile, readSlot, syncSlot } from '../lib/prompt.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const flags = new Set(argv.slice(1).filter((a) => a.startsWith('--')));

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

function needInstall() {
  const inst = findZCodeInstall();
  if (!inst) {
    console.error(C.bad('找不到 ZCode 安装（缺少 resources/glm/zcode.cjs）。'));
    console.error(C.dim('设置 ZCODE_HOME 指向安装根目录，例如 set ZCODE_HOME=D:\\Zcode'));
    process.exit(2);
  }
  return inst;
}

function stateLabel(state) {
  if (state === 'applied') return C.ok('已生效');
  if (state === 'pending') return C.warn('待应用');
  if (state === 'patched') return C.ok('已打上');
  if (state === 'missing') return C.bad('跳过（锚点不符）');
  return C.dim(state);
}

function cmdStatus() {
  ensurePromptFile();
  const inst = findZCodeInstall();
  console.log(C.b('zcode-purge status'));
  console.log(`  用户数据根 : ${userDataRoot()}`);
  console.log(`  安装根     : ${inst ? inst.root : C.bad('未找到')}`);
  if (inst) console.log(`  引擎       : ${inst.engine}`);
  console.log(`  注入源     : ${promptInjectPath()} ${C.dim(`(${readSlot().length} 字符进槽)`)}`);

  if (inst) {
    console.log(`\n${C.b('补丁')}`);
    for (const p of patch.inspect(inst.engine)) {
      const tag = p.required ? '必需' : '可选';
      console.log(`  [${tag}] ${p.id.padEnd(26)} ${stateLabel(p.state)}  ${C.dim(p.title)}`);
    }
    console.log(`  备份       : ${patch.hasBackup(inst.engine) ? C.ok('存在') : C.dim('无')}`);
  }

  const h = hooks.status();
  console.log(`\n${C.b('hooks（手工模式）')}`);
  console.log(`  配置文件   : ${h.file}`);
  console.log(`  enabled    : ${h.enabled ? C.ok('true') : C.dim('false')}`);
  const evs = Object.keys(h.events || {});
  console.log(`  已注册事件 : ${evs.length ? C.ok(evs.join(', ')) : C.dim('无')}`);
  const missing = Object.entries(h.scripts || {}).filter(([n, ok]) => evs.length && !ok).map(([n]) => n);
  if (missing.length) console.log(`  ${C.bad('脚本缺失')}: ${missing.join(', ')}`);
  if (h.error) console.log(`  ${C.bad('配置解析失败')}: ${h.error}`);

  const p = installer.pluginStatus();
  console.log(`\n${C.b('插件')}`);
  if (p.error) {
    console.log(`  状态       : ${C.warn(p.error)}`);
  } else {
    console.log(`  已安装     : ${p.installed ? C.ok('是') : C.dim('否')}`);
    if (p.installed) {
      console.log(`  路径       : ${p.path || '-'}`);
      console.log(`  状态       : ${p.enabled ? C.ok('enabled') : C.warn('disabled')}`);
    }
  }
  const s = installer.installStatus();
  console.log(`  运行时副本 : ${s.runtimeReady ? C.ok(s.runtimeBin) : C.dim('未部署（跑 install 或 deploy）')}`);
}

function cmdApply() {
  ensurePromptFile();
  const s = syncSlot();
  if (!s.ok) {
    console.error(C.bad(s.reason || '注入槽同步失败'));
    process.exit(1);
  }
  const inst = needInstall();
  const r = patch.apply(inst.engine, { includeOptional: !flags.has('--no-optional') });

  console.log(C.b('zcode-purge apply'));
  for (const item of r.results) {
    console.log(`  ${item.id.padEnd(26)} ${stateLabel(item.state)}  ${C.dim(item.reason || '')}`);
  }
  if (!r.verified) {
    console.error(C.bad(`语法校验失败，已放弃写入：\n${r.error}`));
    process.exit(1);
  }
  console.log(r.changed ? C.ok('\n已写入引擎并备份原文件。') : C.dim('\n没有需要改写的补丁。'));
  console.log(C.warn('提醒：完全退出 ZCode 再启动，补丁才会进新进程；旧会话不会重载。'));

  if (flags.has('--with-hooks')) {
    const h = hooks.install({ includeUserPrompt: flags.has('--with-user-prompt') });
    console.log(C.ok(`hooks 已写入 ${h.file}（${h.events.join(', ')}）`));
    console.log(C.dim('如果 ZCode 正开着，请在 设置 → 插件管理 里确认 hook 已注册；或重启客户端。'));
  }
}

function cmdRevert() {
  const inst = needInstall();
  const r = patch.revert(inst.engine);
  console.log(C.b('zcode-purge revert'));
  if (!r.changed) {
    console.log(C.dim(`  ${r.reason}`));
    return;
  }
  console.log(r.verified ? C.ok('  已用备份还原引擎，备份文件已删除。') : C.bad(`  还原后语法校验失败：${r.error}`));
  console.log(C.warn('  提醒：完全退出 ZCode 再启动才算真正还原。'));
}

function cmdHooks() {
  const sub = argv[1] || 'status';
  if (sub === 'install') {
    const r = hooks.install({ includeUserPrompt: flags.has('--with-user-prompt') });
    console.log(C.ok(`已写入 ${r.file}`));
    console.log(`事件：${r.events.join(', ')}`);
    console.log(`脚本：${r.scripts.length} 个已落盘到 ~/.zcode/purge/hooks`);
    console.log(C.dim('hooks 走 ZCode 官方扩展点，不修改安装文件。'));
    return;
  }
  if (sub === 'remove') {
    const r = hooks.remove();
    console.log(r.changed ? C.ok(`已移除：${r.removed.join(', ')}`) : C.dim('没有本工具注册的 hook。'));
    return;
  }
  const s = hooks.status();
  console.log(C.b('zcode-purge hooks'));
  console.log(`  文件    : ${s.file}`);
  console.log(`  enabled : ${s.enabled}`);
  console.log(`  事件    : ${Object.keys(s.events || {}).join(', ') || '无'}`);
}

function cmdPrompt() {
  const { md } = ensurePromptFile();
  if (flags.has('--sync')) {
    const s = syncSlot();
    console.log(s.ok ? C.ok(`注入槽已同步：${s.chars} 字符 → ${s.slot}`) : C.bad(s.reason));
    return;
  }
  console.log(md);
}

function cmdVerify() {
  const inst = needInstall();
  const check = patch.syntaxCheck(inst.engine);
  console.log(C.b('zcode-purge verify'));
  console.log(`  引擎语法 : ${check.ok ? C.ok('OK') : C.bad('FAILED')}`);
  if (!check.ok) console.log(check.error);
  const slot = readSlot();
  console.log(`  注入槽   : ${slot ? C.ok(`${slot.length} 字符`) : C.warn('空（先跑 prompt --sync）')}`);
  const h = hooks.status();
  console.log(`  hooks    : ${h.enabled && Object.keys(h.events).length ? C.ok('已装') : C.warn('未装')}`);
  if (inst.engine.includes('.zcpurge')) console.log(C.bad('  异常：引擎路径被污染'));
}

function cmdInstall() {
  const scope = flags.has('--project') ? 'project' : 'user';
  const skipPlugin = flags.has('--no-plugin');

  console.log(C.b('zcode-purge install'));
  const probe = installer.cliAvailable();
  console.log(`  zcode CLI : ${probe.ok ? C.ok(probe.version) : C.warn('不可用（将只做手工部署）')}`);
  if (!probe.ok && !skipPlugin) {
    console.log(C.dim('  找不到可调用的 ZCode，自动退回 --no-plugin 手工模式'));
  }

  const r = installer.fullInstall({ scope, skipPlugin: skipPlugin || !probe.ok });

  console.log(`  运行时副本 : ${C.ok(r.runtime.dest)} ${C.dim(`(${r.runtime.copied.length} 个文件)`)}`);
  console.log(`  注入槽     : ${r.slot.ok ? C.ok(`${r.slot.chars} 字符`) : C.bad(r.slot.reason)}`);
  console.log(`  旧手工 hook: ${r.hooks.removed.length ? C.ok(`已清理 ${r.hooks.removed.join(', ')}`) : r.hooks.shellCleanup ? C.ok('已清掉空壳配置') : C.dim('无')}`);

  if (r.plugin.length) {
    console.log(`\n${C.b('插件')}`);
    for (const s of r.plugin) console.log(`  ${s.ok ? C.ok('ok  ') : C.bad('fail')} ${s.step}  ${C.dim(s.out || '')}`);
  }

  console.log(`\n${C.b('引擎补丁')}`);
  if (r.patch.error) {
    console.log(`  ${C.bad(r.patch.error)}`);
  } else {
    for (const x of r.patch.results) console.log(`  ${x.id.padEnd(26)} ${stateLabel(x.state)}`);
    console.log(`  ${r.patch.verified ? C.ok('语法校验通过') : C.bad('语法校验失败')}`);
  }

  console.log(`\n${C.ok('装完了。')} ${C.warn('完全退出 ZCode 再启动 —— 补丁是文件级替换，旧进程里还是旧代码。')}`);
  console.log(C.dim(`插件形态下，以后每次开新会话 SessionStart hook 会自动检查并重打补丁（升级自愈）。`));
}

function cmdUninstall() {
  const scope = flags.has('--project') ? 'project' : 'user';
  const keepData = flags.has('--keep-data');

  console.log(C.b('zcode-purge uninstall'));
  const r = installer.fullUninstall({ scope, keepData });

  console.log(`  引擎还原 : ${r.patch?.changed ? C.ok('已用备份还原') : C.dim(r.patch?.reason || '无改动')}`);
  if (r.patch?.verified === false) console.log(`  ${C.bad('还原后语法校验失败')}: ${r.patch.error}`);
  if (r.plugin.length) {
    console.log(`\n${C.b('插件')}`);
    for (const s of r.plugin) console.log(`  ${s.ok ? C.ok('ok  ') : C.bad('fail')} ${s.step}  ${C.dim(s.out || '')}`);
  }
  if (r.cleaned.length) {
    console.log(`\n${C.b('已清理')}`);
    for (const p of r.cleaned) console.log(`  ${p}`);
  }
  console.log(`\n${C.ok('移除完成。')} ${C.warn('重启 ZCode 让引擎回到原版。')}`);
}

function cmdDeploy() {
  const r = installer.deployRuntimeCopy();
  const s = syncSlot();
  ensurePromptFile();
  console.log(C.b('zcode-purge deploy'));
  console.log(`  运行时副本 : ${r.dest} ${C.dim(`(${r.copied.length} 个文件)`)}`);
  console.log(`  注入槽     : ${s.ok ? `${s.chars} 字符` : C.bad(s.reason)}`);
  console.log(C.dim(`手动入口: node "${installer.runtimeBinPath()}" status`));
}

async function cmdProof() {
  const doProbe = !flags.has('--no-probe');

  // 先跑探针：它会启动一次 ZCode CLI，顺带把含 hookCount 的启动日志刷新到最新。
  // 反过来先读日志会读到部署前的旧记录，第一次部署必然误报 FAIL。
  let pr = null;
  if (doProbe) {
    console.log(C.dim('正在起假 provider 抓一次真实请求（约 10–30 秒，不消耗 token、不联网）…\n'));
    pr = await runProbe({});
  }

  const s = statusLib.collect();
  const v = statusLib.verdict(s);

  console.log(C.b('zcode-purge proof —— 到底生效没有'));
  console.log(`  安装 : ${s.install ? s.install.engine : C.bad('未找到')}`);
  console.log(`  注入 : ${s.promptPath} ${C.dim(`(${s.slot.chars} 字符进槽)`)}\n`);

  for (const r of v.rows) {
    const t = r.ok ? C.ok('PASS') : C.bad('FAIL');
    console.log(`  [${t}] ${r.name.padEnd(20)} ${C.dim(`${r.layer} · ${r.detail || ''}`)}`);
  }
  console.log(`\n  ${v.allOk ? C.ok('静态检查全过。') : C.warn('有项目没过，看上面 FAIL。')}`);

  if (!doProbe) {
    console.log(C.dim('\n  跳过真实请求验证（--no-probe）。要看最硬的证据就去掉这个参数。'));
    return;
  }

  if (!pr.checks?.length) {
    console.log(`\n  ${C.bad('探针失败')}: ${pr.reason}`);
    console.log(C.dim('  常见原因：ZCode 正在跑但 CLI 起不来、端口被占、或 provider 配置被锁。'));
    return;
  }

  console.log(`\n${C.b('真实请求实拍')}`);
  for (const c of pr.checks) {
    console.log(`  [${c.ok ? C.ok('PASS') : C.bad('FAIL')}] ${c.name}${c.detail ? `  ${C.dim(c.detail)}` : ''}`);
  }
  console.log(`\n  请求体 ${pr.requestBytes} 字节`);
  console.log(C.dim('  system 段实测前 300 字：'));
  console.log(C.dim(`  ${(pr.systemSample || '').slice(0, 300).replace(/\n/g, '\n  ')}`));
  console.log(
    pr.ok
      ? `\n${C.ok('结论：三层都进到真实请求里了。')}`
      : `\n${C.bad('结论：请求里没看到预期内容 —— 大概率是没重启 ZCode，或补丁被升级覆盖了。')}`
  );
}

async function cmdPanel() {
  const port = Number((argv.find((a) => a.startsWith('--port=')) || '').split('=')[1] || 17871);
  const { url } = await startPanel({ port, open: !flags.has('--no-open') });
  console.log(C.b('zcode-purge panel'));
  console.log(`  控制台 : ${C.ok(url)}`);
  console.log(C.dim('  只监听 127.0.0.1。Ctrl+C 关闭。'));
  console.log(C.dim('  没自动打开就手动访问上面地址。'));
}

function cmdHelp() {
  console.log(`zcode-purge —— ZCode 三层解绑工具（装成插件 / 移植 / 移除）

部署:
  zcode-purge install                一键部署：运行时副本 + 注册 marketplace + 装插件 + 打补丁
  zcode-purge install --no-plugin    只做手工部署（不装插件，用 config.json 里的 hooks）
  zcode-purge install --project      装到 project 作用域而不是 user
  zcode-purge uninstall              一键移除：还原引擎 + 卸插件 + 清市场 + 删数据
  zcode-purge uninstall --keep-data  移除但保留 ~/.zcode/purge（保留注入词）
  zcode-purge deploy                 只同步运行时副本与注入槽（不动引擎）

日常:
  zcode-purge proof                  一条命令看"到底生效没有"（静态 + 真实请求抓取）
  zcode-purge proof --no-probe        只看静态检查，不跑请求
  zcode-purge panel                  本地网页控制台（状态 / 按钮 / 注入词编辑 / 验证）
  zcode-purge panel --port=17871      指定端口
  zcode-purge status                 查看补丁 / hooks / 注入槽 / 插件状态
  zcode-purge apply                  同步注入槽并打补丁（默认含可选补丁）
  zcode-purge apply --with-hooks     手工模式：顺带写入 SessionStart / PreToolUse hook
  zcode-purge apply --no-optional    只打必需补丁
  zcode-purge revert                 用备份还原引擎
  zcode-purge hooks install|remove   手工 hook 的装卸（插件形态不需要）
  zcode-purge prompt [--sync]        看注入词路径 / 把 md 写进注入槽
  zcode-purge verify                 语法 / 槽 / hooks 自检

移植:
  整个目录拷到新机器 → node bin/zcode-purge.mjs install
  不用写死盘符：安装位置自动探测，node 路径取当前进程。

环境变量:
  ZCODE_HOME              ZCode 安装根目录（找不到安装时手动指定）
  ZCODE_USER_HOME         用户数据根（默认 ~/.zcode）

分层:
  提示词层  system prompt 里的安全条款被换成"运行时读取 ~/.zcode/purge/inject-slot.txt"
  审批层    guarded 不再把 yolo 拉回去
  注入层    插件 hooks：SessionStart 自愈+注入，PreToolUse 全放行工具
`);
}

const table = {
  status: cmdStatus,
  proof: cmdProof,
  panel: cmdPanel,
  apply: cmdApply,
  revert: cmdRevert,
  hooks: cmdHooks,
  prompt: cmdPrompt,
  verify: cmdVerify,
  install: cmdInstall,
  uninstall: cmdUninstall,
  deploy: cmdDeploy,
  help: cmdHelp,
  '--help': cmdHelp,
  '-h': cmdHelp,
};

const fn = table[cmd];
if (!fn) {
  console.error(C.bad(`未知命令: ${cmd}`));
  cmdHelp();
  process.exit(2);
}
const ret = fn();
if (ret && typeof ret.then === 'function') {
  ret.then((code) => {
    if (typeof code === 'number') process.exit(code);
  });
}
