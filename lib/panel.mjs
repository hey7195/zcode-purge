// 本地控制台：zcode-purge panel
// ZCode 插件规范不支持往客户端塞侧栏按钮，所以用本地网页做等价的控制窗口：
// 状态、逐层证据、注入词编辑、应用/还原/卸载、一键抓一次真实请求验证。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { collect, verdict } from './status.mjs';
import { runProbe } from './probe.mjs';
import { ensurePromptFile, syncSlot } from './prompt.mjs';
import * as patch from './patch.mjs';
import * as installer from './installer.mjs';
import { findZCodeInstall, promptInjectPath, purgeRoot } from './paths.mjs';

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>zcode-purge</title>
<style>
:root{--bg:#0f1115;--card:#181b22;--line:#262b35;--fg:#e6e8ee;--dim:#8b93a6;--ok:#3ddc84;--bad:#ff5d5d;--warn:#f5c451;--accent:#6ea8fe}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 ui-sans-serif,system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:22px 18px 60px}
h1{font-size:16px;margin:0 0 2px;letter-spacing:.3px}
.sub{color:var(--dim);font-size:12px;margin-bottom:16px}
.banner{border-radius:10px;padding:12px 14px;margin-bottom:16px;border:1px solid var(--line);display:flex;align-items:center;gap:10px;font-weight:600}
.banner.ok{background:rgba(61,220,132,.08);border-color:rgba(61,220,132,.35);color:var(--ok)}
.banner.bad{background:rgba(255,93,93,.08);border-color:rgba(255,93,93,.35);color:var(--bad)}
.banner .hint{font-weight:400;color:var(--dim);font-size:12px}
.grid{display:grid;gap:12px}
.cols{grid-template-columns:1fr 1fr}
@media(max-width:720px){.cols{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.9px;color:var(--dim);margin:0 0 10px;font-weight:600}
table{width:100%;border-collapse:collapse}
td{padding:7px 0;vertical-align:top;border-bottom:1px solid rgba(38,43,53,.6);font-size:13px}
tr:last-child td{border-bottom:none}
.tag{display:inline-block;min-width:52px;text-align:center;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:700;margin-right:8px}
.tag.ok{background:rgba(61,220,132,.16);color:var(--ok)}
.tag.bad{background:rgba(255,93,93,.16);color:var(--bad)}
.tag.warn{background:rgba(245,196,81,.16);color:var(--warn)}
.d{color:var(--dim);font-size:12px;margin-top:2px;word-break:break-all}
button{background:#212633;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 13px;font:inherit;font-size:13px;cursor:pointer;margin:0 6px 6px 0}
button:hover{border-color:var(--accent);color:#fff}
button.primary{background:rgba(110,168,254,.14);border-color:rgba(110,168,254,.45);color:var(--accent)}
button.danger{background:rgba(255,93,93,.1);border-color:rgba(255,93,93,.35);color:var(--bad)}
button:disabled{opacity:.5;cursor:default}
textarea{width:100%;min-height:190px;background:#0c0e13;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:10px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical}
pre{background:#0c0e13;border:1px solid var(--line);border-radius:8px;padding:10px;font:12px/1.5 ui-monospace,Consolas,monospace;overflow:auto;max-height:260px;white-space:pre-wrap;word-break:break-all;color:#c8cede}
.kv{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(38,43,53,.6);font-size:13px}
.kv:last-child{border-bottom:none}
.kv span:first-child{color:var(--dim)}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
#msg{min-height:20px;font-size:12px;color:var(--warn);margin-top:8px}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--dim);border-top-color:transparent;border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes s{to{transform:rotate(360deg)}}
</style></head><body>
<div class="wrap">
  <h1>zcode-purge</h1>
  <div class="sub" id="sub">加载中…</div>
  <div class="banner bad" id="banner"><span id="bannerText">检查中…</span></div>

  <div class="grid cols" style="margin-bottom:12px">
    <div class="card"><h2>逐层证据</h2><table id="checks"></table></div>
    <div class="card"><h2>运行时</h2><div id="runtime"></div></div>
  </div>

  <div class="card" style="margin-bottom:12px">
    <h2>动作</h2>
    <button class="primary" onclick="act('apply')">打补丁 / 重新应用</button>
    <button onclick="act('sync')">同步注入词到槽</button>
    <button onclick="act('probe')">抓一次真实请求验证</button>
    <button onclick="act('revert')">还原引擎</button>
    <button class="danger" onclick="act('uninstall')">完全移除</button>
    <div id="msg"></div>
  </div>

  <div class="card" style="margin-bottom:12px">
    <h2>注入词（prompt-inject.md）</h2>
    <textarea id="prompt" spellcheck="false"></textarea>
    <div style="margin-top:8px">
      <button class="primary" onclick="savePrompt()">保存并同步</button>
      <span class="d" id="promptPath"></span>
    </div>
  </div>

  <div class="card"><h2>上次验证的 system 段</h2><pre id="sample">还没抓过。点上面的「抓一次真实请求验证」。</pre></div>
</div>
<script>
const $=s=>document.querySelector(s);
const msg=(t,spin)=>{$('#msg').innerHTML=(spin?'<span class="spin"></span>':'')+ (t||'');};
const tag=ok=>ok?'<span class="tag ok">PASS</span>':'<span class="tag bad">FAIL</span>';

async function refresh(){
  const r = await fetch('/api/state').then(x=>x.json());
  $('#sub').textContent = (r.install? r.install.engine : '未找到 ZCode 安装') + '   ·   ' + (r.promptPath||'');
  const b=$('#banner');
  b.className='banner '+(r.verdict.allOk?'ok':'bad');
  $('#bannerText').innerHTML = r.verdict.allOk
    ? '生效中 ✓ <span class="hint">三层全部通过</span>'
    : '还没完全生效 <span class="hint">看下面哪一项是 FAIL</span>';
  $('#checks').innerHTML = r.verdict.rows.map(x=>
    '<tr><td>'+tag(x.ok)+'<b>'+x.name+'</b><div class="d">'+x.layer+' · '+(x.detail||'')+'</div></td></tr>').join('');
  const rt=r.runtime, pl=r.plugin, lg=r.log;
  $('#runtime').innerHTML = [
    ['插件', pl.installed?(pl.enabled?'已安装 enabled':'已安装但 disabled'):'未安装'],
    ['插件路径', pl.path||'-'],
    ['hook 注册数', lg.available? String(lg.hookCount) : '无日志'],
    ['注入槽', r.slot.chars+' 字符'],
    ['备份文件', r.backup?'存在':'无'],
    ['运行时副本', rt.runtimeReady?'已部署':'未部署'],
    ['自动重打', r.config.autoApply===false?'关':'开'],
    ['自动放行', r.config.autoApprove===false?'关':'开'],
  ].map(([k,v])=>'<div class="kv"><span>'+k+'</span><span class="mono">'+v+'</span></div>').join('');
  if(!$('#prompt').dataset.touched){ $('#prompt').value = r.promptText||''; }
  $('#promptPath').textContent = r.promptPath||'';
}

async function act(what){
  if(what==='uninstall' && !confirm('会还原引擎、卸载插件、删除 ~/.zcode/purge。继续？')) return;
  msg(({apply:'正在打补丁…',sync:'正在同步注入词…',probe:'正在起假 provider 抓请求，约 10–30 秒…',revert:'正在还原…',uninstall:'正在移除…'})[what], true);
  try{
    const r = await fetch('/api/'+what,{method:'POST'}).then(x=>x.json());
    msg(r.message||'完成');
    if(r.sample){ $('#sample').textContent = r.sample; }
    await refresh();
  }catch(e){ msg('失败: '+e); }
}

async function savePrompt(){
  msg('保存中…', true);
  const text = $('#prompt').value;
  const r = await fetch('/api/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})}).then(x=>x.json());
  $('#prompt').dataset.touched='';
  msg(r.message||'已保存');
  await refresh();
}
$('#prompt').addEventListener('input',e=>{e.target.dataset.touched='1';});
refresh();
setInterval(()=>{ if(!$('#msg').innerHTML.includes('spin')) refresh(); }, 8000);
</script></body></html>`;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readPrompt() {
  ensurePromptFile();
  try {
    return fs.readFileSync(promptInjectPath(), 'utf8');
  } catch {
    return '';
  }
}

function localOnly(req) {
  const host = String(req.headers.host || '');
  return host.startsWith('127.0.0.1') || host.startsWith('localhost');
}

export async function startPanel({ port = 17871, open = true } = {}) {
  const server = http.createServer(async (req, res) => {
    if (!localOnly(req)) {
      res.writeHead(403);
      res.end('local only');
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const s = collect();
      json(res, 200, { ...s, verdict: verdict(s), promptText: readPrompt() });
      return;
    }

    try {
      if (req.method === 'POST' && url.pathname === '/api/apply') {
        const s0 = syncSlot();
        const inst = findZCodeInstall();
        if (!inst) return json(res, 200, { message: '找不到 ZCode 安装' });
        const r = patch.apply(inst.engine, { includeOptional: true });
        const ok = r.verified;
        return json(res, 200, {
          message: ok
            ? `已应用（${r.results.map((x) => `${x.id}:${x.state}`).join(', ')}）· 注入槽 ${s0.chars} 字符 · 重启 ZCode 生效`
            : `语法校验失败，已放弃写入：${r.error}`,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/sync') {
        const s = syncSlot();
        return json(res, 200, { message: s.ok ? `注入槽已更新：${s.chars} 字符（新会话生效）` : s.reason });
      }

      if (req.method === 'POST' && url.pathname === '/api/revert') {
        const inst = findZCodeInstall();
        if (!inst) return json(res, 200, { message: '找不到 ZCode 安装' });
        const r = patch.revert(inst.engine);
        return json(res, 200, { message: r.changed ? '已用备份还原引擎，重启 ZCode 生效' : r.reason });
      }

      if (req.method === 'POST' && url.pathname === '/api/probe') {
        const r = await runProbe({ port: port + 1 });
        const lines = (r.checks || []).map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
        return json(res, 200, {
          message: r.ok ? `全部通过（请求 ${r.requestBytes} 字节）` : r.reason || '有检查没过',
          sample: `${lines.join('\n')}\n\n--- system 段前 900 字 ---\n${r.systemSample || ''}`,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/prompt') {
        let body = '';
        req.on('data', (c) => (body += c));
        await new Promise((r) => req.on('end', r));
        const { text } = JSON.parse(body || '{}');
        ensurePromptFile();
        fs.mkdirSync(purgeRoot(), { recursive: true });
        fs.writeFileSync(promptInjectPath(), String(text ?? ''), 'utf8');
        const s = syncSlot();
        return json(res, 200, { message: s.ok ? `已保存并同步：${s.chars} 字符` : s.reason });
      }

      if (req.method === 'POST' && url.pathname === '/api/uninstall') {
        const r = installer.fullUninstall({ keepData: false });
        return json(res, 200, {
          message: `已移除：引擎${r.patch?.changed ? '已还原' : '未改动'}，插件 ${r.plugin.map((x) => x.step).join(' / ')}`,
        });
      }
    } catch (err) {
      return json(res, 500, { message: String(err.message || err) });
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const url = `http://127.0.0.1:${port}/`;
  if (open) {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    execFile(cmd, args, { windowsHide: true }, () => {});
  }
  return { server, url };
}
