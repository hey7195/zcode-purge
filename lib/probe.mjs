// 生效探针：起一个本地假 provider，让 zcode CLI 真跑一轮，把模型请求截下来，
// 直接回答"补丁和注入到底进没进请求"。不联网、不消耗真实 token。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { findZCodeInstall, promptInjectPath } from './paths.mjs';

export const SECURITY_MARKER = 'Refuse requests for destructive techniques';

export function zcodeTargets() {
  const inst = findZCodeInstall();
  if (!inst) return null;
  const exe = path.join(inst.root, process.platform === 'win32' ? 'ZCode.exe' : 'ZCode');
  if (!fs.existsSync(exe)) return null;
  return { exe, cli: inst.engine, root: inst.root };
}

export function readSlot() {
  try {
    return fs.readFileSync(path.join(path.dirname(promptInjectPath()), 'inject-slot.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** 从注入槽里挑一句够独特的话当探针，避免误判。 */
export function slotProbe(slot = readSlot()) {
  return (
    slot
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 8 && !l.startsWith('-') && !l.startsWith('#'))?.slice(0, 18) || ''
  );
}

/**
 * 跑一次真实请求抓取。
 * @returns {Promise<{ok:boolean, reason?:string, checks:{name,ok,detail}[], systemSample?:string, requestBytes?:number}>}
 */
export async function runProbe({ port = 18771, deadline = 120000, timeoutMs = 180000 } = {}) {
  const t = zcodeTargets();
  if (!t) return { ok: false, reason: '找不到 ZCode 安装', checks: [] };

  const slot = readSlot();
  const probe = slotProbe(slot);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcpurge-probe-'));
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
                  api: { type: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${port}/v1` },
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

  try {
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, reason: `端口 ${port} 起不来: ${err.message}`, checks: [] };
  }

  let out = '';
  let exitCode = null;
  const child = spawn(t.exe, [t.cli, '-p', 'reply with OK only', '--json', '--cwd', t.root], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NO_COLOR: '1',
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.join(path.dirname(t.cli), '..', 'config', 'provider', 'zcode-builtin.json'),
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerCfg,
    },
    windowsHide: true,
  });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, Math.min(timeoutMs, deadline + 60000));
    child.on('exit', (code) => {
      exitCode = code;
      clearTimeout(timer);
      resolve();
    });
  });

  server.close();
  await new Promise((r) => setTimeout(r, 400));
  fs.rmSync(tmp, { recursive: true, force: true });

  const modelReqs = captures.filter((c) => !String(c.url).includes('/models') && c.body);
  if (modelReqs.length === 0) {
    return {
      ok: false,
      reason: `ZCode 没有发出模型请求（exit=${exitCode}）${out.slice(-300)}`,
      checks: [],
    };
  }

  const req = JSON.parse(modelReqs[modelReqs.length - 1].body);
  const flat = JSON.stringify(req);
  const msgs = req.messages || req.input || [];
  const systemText = msgs
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');

  const checks = [
    { name: '系统提示词里的安全条款已消失', ok: !flat.includes(SECURITY_MARKER), detail: SECURITY_MARKER },
    { name: '注入槽进了 system 段', ok: !!probe && systemText.includes(probe), detail: probe ? `探针「${probe}…」` : '槽为空' },
    { name: '身份段仍在（没有整体跳过）', ok: /interactive coding agent|You are ZCode/.test(flat) },
    { name: '用户消息正常下发', ok: flat.includes('reply with OK only') },
    {
      name: 'hook 注入进了消息流',
      ok: !!probe && JSON.stringify(msgs.filter((m) => m.role !== 'system')).includes(probe),
      detail: 'SessionStart additionalContext',
    },
  ];

  return {
    ok: checks.every((c) => c.ok),
    checks,
    systemSample: systemText.slice(0, 900),
    requestBytes: Buffer.byteLength(JSON.stringify(req)),
    exitCode,
  };
}
