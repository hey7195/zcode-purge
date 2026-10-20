// 端到端验证：起假 provider，让 zcode CLI 真跑一轮，抓请求体检查三层是否生效。
// 不访问外网、不消耗真实 token；请求体落在临时目录，不污染仓库（仓库要能直接当插件分发）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { findZCodeInstall } from '../lib/paths.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PORT = Number(process.env.PROBE_PORT || 18765);
const inst = findZCodeInstall();
const ZCODE_EXE =
  process.env.ZCODE_EXE || (inst ? path.join(inst.root, process.platform === 'win32' ? 'ZCode.exe' : 'ZCode') : '');
const CLI = process.env.ZCODE_CLI || inst?.engine || '';
const DEADLINE = Number(process.env.PROBE_DEADLINE || 90000);

if (!ZCODE_EXE || !fs.existsSync(ZCODE_EXE) || !CLI) {
  console.error('找不到 ZCode 安装，设置 ZCODE_HOME 后重试');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcpurge-e2e-'));
const providerCfg = path.join(tmp, 'provider.json');
const captures = [];

fs.writeFileSync(
  providerCfg,
  JSON.stringify(
    {
      schemaVersion: 1,
      config: {
        providerOrder: ['purge-probe'],
        providerConfigRules: {
          providerRules: [
            {
              providerId: 'purge-probe',
              providerName: 'purge-probe',
              config: {
                group: 'standard-personal',
                access: { type: 'api-key', apiKey: 'sk-probe' },
                api: { type: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${PORT}/v1` },
                personalModelIds: ['probe-model'],
                modelOrder: ['probe-model'],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [
            { modelId: 'probe-model', config: { properties: { contextWindow: 200000 } }, providerId: 'purge-probe' },
          ],
          manualProviderModelRules: [],
        },
      },
    },
    null,
    2
  )
);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    captures.push({ url: req.url, body });
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({
      id: 'chatcmpl-probe',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'probe-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }],
    });
    send({
      id: 'chatcmpl-probe',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'probe-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`假端点：http://127.0.0.1:${PORT}/v1`);

const child = spawn(ZCODE_EXE, [CLI, '-p', 'reply with OK only', '--json', '--cwd', repo], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NO_COLOR: '1',
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.join(path.dirname(CLI), '..', 'config', 'provider', 'zcode-builtin.json'),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerCfg,
  },
  windowsHide: true,
});

let out = '';
child.stdout.on('data', (d) => {
  out += d;
});
child.stderr.on('data', (d) => {
  out += d;
});

await new Promise((resolve) => {
  const t = setTimeout(() => {
    child.kill();
    resolve();
  }, DEADLINE);
  child.on('exit', () => {
    clearTimeout(t);
    resolve();
  });
});

server.close();
await new Promise((r) => setTimeout(r, 400));

const modelReqs = captures.filter((c) => !String(c.url).includes('/models') && c.body);
if (modelReqs.length === 0) {
  console.error('FAIL  没有捕获到模型请求');
  console.error(out.slice(-1200));
  process.exit(1);
}

const req = JSON.parse(modelReqs[modelReqs.length - 1].body);
const keepPath = path.join(os.tmpdir(), 'zcode-purge-last-request.json');
fs.writeFileSync(keepPath, JSON.stringify(req, null, 2), 'utf8');
const flat = JSON.stringify(req);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

let slot = '';
try {
  slot = fs.readFileSync(path.join(os.homedir(), '.zcode', 'purge', 'inject-slot.txt'), 'utf8').trim();
} catch {
  /* noop */
}
const probe =
  slot
    .split('\n')
    .find((l) => l.trim().length > 8 && !l.trim().startsWith('-') && !l.trim().startsWith('#'))
    ?.trim() || '';

// hook 注入只有装了插件 / 手工 hooks 才应该出现，没装就不做这项要求
const { cliAvailable, pluginStatus } = await import('../lib/installer.mjs');
const hooksInstalled = (() => {
  const p = pluginStatus();
  return !!(p.installed && p.enabled);
})();

check('捕获到模型请求', true, `${modelReqs.length} 条`);
check('原始安全条款已消失', !flat.includes('Refuse requests for destructive techniques'));
check('注入槽已进 system 段', probe ? flat.includes(probe.slice(0, 18)) : false, probe ? `探针: ${probe.slice(0, 22)}…` : '槽为空');
check('身份段仍在（未整体跳过）', flat.includes('interactive coding agent') || flat.includes('You are ZCode'));
check('用户消息正常', flat.includes('reply with OK only'));

const msgs = req.messages || req.input || [];
if (hooksInstalled) {
  check('hook additionalContext 进入消息流', !!(probe && JSON.stringify(msgs).includes(probe.slice(0, 18))));
} else {
  console.log('SKIP  hook additionalContext 进入消息流  （当前没装插件 / 手工 hooks）');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
console.log(`请求体已存: ${keepPath}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
