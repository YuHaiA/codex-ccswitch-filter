'use strict';
// Local web control panel for the filter. Listens on 127.0.0.1 only; every API call needs a per-run token.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {randomBytes, timingSafeEqual} = require('node:crypto');
const filter = require('./filter.cjs');
const {providerBase, sameEndpoint} = require('./config.cjs');

const PANEL_SERVICE = 'ccswitch-codex-filter-panel-v1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parsePanelArgs(argv) {
  const mode = (argv.shift() || 'open').toLowerCase();
  if (!['open', 'serve', 'stop-all'].includes(mode)) throw new Error('Use open, serve or stop-all.');
  let panelPort = 18180;
  const rest = [];
  while (argv.length) {
    const key = argv.shift();
    if (key === '--panel-port') panelPort = Number(argv.shift());
    else rest.push(key, argv.shift() ?? '');
  }
  // Reuse filter.cjs validation for --port/--config/--runtime/--upstream/--cc-db.
  const options = filter.parseArgs(['status', ...rest]);
  if (!Number.isInteger(panelPort) || panelPort < 1024 || panelPort > 65535) throw new Error('Panel port must be 1024-65535.');
  if (panelPort === options.port) throw new Error('Panel port must differ from filter port.');
  const filterArgs = [];
  for (let i = 0; i < rest.length; i += 2) filterArgs.push(rest[i], rest[i + 1]);
  return {mode, panelPort, options, filterArgs};
}

const panelFile = options => path.join(options.runtime, 'panel.json');
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

function callPanel(record, route, method = 'GET', timeout = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${record.port}${route}`,
      {method, headers: {'x-panel-token': record.token}}, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode !== 200) throw new Error(data.error || 'Panel returned HTTP ' + res.statusCode);
            resolve(data);
          } catch (error) { reject(error); }
        });
      });
    req.setTimeout(timeout, () => req.destroy(new Error('Panel timed out.')));
    req.on('error', reject);
    req.end();
  });
}
async function livePanel(options) {
  const record = readJson(panelFile(options));
  if (!record) return null;
  try {
    const ping = await callPanel(record, '/api/ping');
    return ping.service === PANEL_SERVICE && ping.pid === record.pid ? record : null;
  } catch { return null; }
}

// open: reuse a running panel or start a detached one, then open the browser.
async function openPanel({panelPort, options, filterArgs}) {
  let record = await livePanel(options);
  if (!record) {
    fs.mkdirSync(options.runtime, {recursive: true});
    const fd = fs.openSync(path.join(options.runtime, 'panel.log'), 'a');
    let child;
    try {
      child = spawn(process.execPath, [__filename, 'serve', '--panel-port', String(panelPort), ...filterArgs],
        {cwd: __dirname, detached: true, windowsHide: true, stdio: ['ignore', fd, fd]});
    } finally { fs.closeSync(fd); }
    child.unref();
    for (let i = 0; i < 40 && !record; i++) {
      await delay(150);
      if (child.exitCode !== null) break;
      record = await livePanel(options);
    }
    if (!record) throw new Error('Panel did not start. See ' + path.join(options.runtime, 'panel.log'));
  }
  const url = `http://127.0.0.1:${record.port}/?t=${record.token}`;
  if (!process.env.CCSWITCH_PANEL_NO_BROWSER) {
    // rundll32 is a GUI program: opens the default browser without creating a console window.
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {detached: true, windowsHide: true, stdio: 'ignore'}).unref();
  }
  console.log('Panel: http://127.0.0.1:' + record.port + '/');
}

function tail(file, maxLines) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size, length = Math.min(size, 16384);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-maxLines);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

function codexRoute(options) {
  try {
    if (!fs.existsSync(options.configPath)) return {baseUrl: null, pointsToFilter: false};
    const entry = providerBase(fs.readFileSync(options.configPath, 'utf8'));
    return {baseUrl: entry?.url ?? null, pointsToFilter: !!entry && sameEndpoint(entry.url, options.filterOrigin)};
  } catch (error) { return {baseUrl: null, pointsToFilter: false, configError: error.message}; }
}

async function serve({panelPort, options}) {
  const token = randomBytes(24).toString('hex');
  const tokenBuffer = Buffer.from(token);
  const page = fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8');
  const allowedHosts = new Set([`127.0.0.1:${panelPort}`, `localhost:${panelPort}`]);
  let busy = null, closing = false, server;

  const authorized = req => {
    const given = Buffer.from(String(req.headers['x-panel-token'] || ''));
    return given.length === tokenBuffer.length && timingSafeEqual(given, tokenBuffer);
  };
  const snapshot = async () => ({filter: await filter.status(options), codex: codexRoute(options), busy,
    filterOrigin: options.filterOrigin, panelPid: process.pid});
  // One filter operation at a time; double clicks get a clear error instead of racing.
  const exclusive = async (name, fn) => {
    if (busy || closing) throw Object.assign(new Error('另一个操作正在进行：' + (busy || '关闭中')), {status: 409});
    busy = name;
    try { return await fn(); } finally { busy = null; }
  };
  const action = (name, fn) => exclusive(name, async () => {
    const before = codexRoute(options).pointsToFilter;
    await fn();
    const after = await snapshot();
    return {ok: true, ...after, routeChanged: before !== after.codex.pointsToFilter};
  });
  const routes = {
    'GET /api/ping': async () => ({service: PANEL_SERVICE, pid: process.pid}),
    'GET /api/status': snapshot,
    'GET /api/log': async () => ({lines: tail(path.join(options.runtime, 'filter.log'), 40)}),
    'POST /api/start': () => action('启动', () => filter.start(options)),
    'POST /api/stop': () => action('停止', () => filter.stop(options)),
    'POST /api/restart': () => action('重启', async () => { await filter.stop(options); await filter.start(options); }),
    // Stop the filter (restoring the Codex address) and then the panel itself.
    'POST /api/shutdown': () => exclusive('全部停止', async () => {
      const result = await filter.stop(options);
      closing = true;
      setTimeout(() => { cleanup(); server.close(() => process.exit(0)); server.closeAllConnections(); }, 200);
      return {ok: true, restored: result.restored};
    })
  };
  const cleanup = () => {
    const record = readJson(panelFile(options));
    if (record?.pid === process.pid) fs.rmSync(panelFile(options), {force: true});
  };
  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, {'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  server = http.createServer(async (req, res) => {
    // Host check blocks DNS rebinding; token check blocks other local pages and sites.
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, {error: 'Forbidden host'});
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      console.log(JSON.stringify({time: new Date().toISOString(), event: 'page-served'}));
      return send(res, 200, page, 'text/html; charset=utf-8');
    }
    const handler = routes[req.method + ' ' + url.pathname];
    if (!handler) return send(res, 404, {error: 'Not found'});
    if (!authorized(req)) return send(res, 401, {error: '令牌无效，请重新双击“打开控制面板.cmd”。'});
    try { send(res, 200, await handler()); }
    catch (error) { send(res, error.status || 500, {error: error.message}); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(panelPort, '127.0.0.1', resolve);
  });
  fs.mkdirSync(options.runtime, {recursive: true});
  fs.writeFileSync(panelFile(options), JSON.stringify({service: PANEL_SERVICE, pid: process.pid, port: panelPort, token,
    startedAt: new Date().toISOString()}, null, 2), {mode: 0o600});
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(0); });
  console.log(JSON.stringify({time: new Date().toISOString(), event: 'panel-listening', port: panelPort}));
}

// stop-all from the command line: through the panel if it runs, otherwise stop the filter directly.
async function stopAll({options}) {
  const record = await livePanel(options);
  const result = record ? await callPanel(record, '/api/shutdown', 'POST', 30000) : await filter.stop(options);
  console.log(JSON.stringify({filterStopped: true, panelStopped: !!record, restored: result.restored}, null, 2));
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required.');
  const parsed = parsePanelArgs(process.argv.slice(2));
  if (parsed.mode === 'serve') await serve(parsed);
  else if (parsed.mode === 'stop-all') await stopAll(parsed);
  else await openPanel(parsed);
}
main().catch(error => { console.error('Panel: ' + error.message); process.exitCode = 1; });