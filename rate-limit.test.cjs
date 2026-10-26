'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const {once} = require('node:events');
const {makeProxy, ADMIN} = require('./proxy.cjs');
const {DEFAULT_POLICY, retryDelay} = require('./rate-limit.cjs');

const fastPolicy = {baseDelayMs: 1, maxDelayMs: 1, minDelayMs: 1, random: () => 0, sniffTimeoutMs: 100};
const payload = {model: 'mock', input: 'hello', store: true};
const azureError = {code: 'rate_limit_exceeded', message:
  'Your requests to gpt-5.6-sol for gpt-5.6-sol in eastus2 have exceeded token rate limit.'};

async function setup(t, handler, retryPolicy = fastPolicy) {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = makeProxy({getUpstream: () => 'http://127.0.0.1:' + upstream.address().port, retryPolicy});
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => {
    for (const server of [proxy, upstream]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  const origin = 'http://127.0.0.1:' + proxy.address().port;
  const health = async () => (await fetch(origin + ADMIN + '/health')).json();
  const call = (body = payload, path = '/responses', signal) => fetch(origin + path,
    {method: 'POST', body: JSON.stringify(body), headers: {'content-type': 'application/json', authorization: 'Bearer mock'}, signal});
  return {origin, call, health};
}

test('retry delay respects server dates, milliseconds and reset headers without shortening long waits', () => {
  const policy = {...DEFAULT_POLICY, random: () => 0, now: () => 0};
  assert.equal(retryDelay({'retry-after': '2'}, 1, policy), 2000);
  assert.equal(retryDelay({'retry-after': new Date(90000).toUTCString()}, 1, policy), 90000);
  assert.equal(retryDelay({'retry-after-ms': '1500', 'x-ms-retry-after-ms': '2500'}, 1, policy), 2500);
  assert.equal(retryDelay({'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '1m2s500ms'}, 1, policy), 62500);
  assert.equal(retryDelay({}, 1, policy), 5000);
  assert.equal(retryDelay({}, 50, policy), 60000);
  assert.equal(retryDelay({'retry-after': 'invalid'}, 1, policy), 5000);
  assert.equal(retryDelay({'retry-after-ms': '-1'}, 1, policy), 5000);
});

test('HTTP rejection can recover on the 50th retry with identical filtered body and authorization', {timeout: 10000}, async t => {
  let attempts = 0, first;
  const {call, health} = await setup(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    first ??= body;
    assert.equal(body, first); assert.equal(req.headers.authorization, 'Bearer mock');
    assert.equal(JSON.parse(body).store, false);
    attempts++;
    res.writeHead(attempts <= 50 ? 429 : 200, {'content-type': 'application/json', 'retry-after-ms': '1'});
    res.end(JSON.stringify(attempts <= 50 ? {error: azureError} : {ok: true}));
  });
  const response = await call(); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true}); assert.equal(attempts, 51);
  const state = await health();
  assert.equal(state.rateLimitMaxRetries, 50); assert.equal(state.filterVersion, 4);
  assert.equal(state.stats.rateLimitRetries, 50); assert.equal(state.stats.rateLimitRecoveries, 1);
  assert.equal(state.stats.filteredRequests, 1); assert.equal(state.stats.requests, 1);
  assert.equal(state.stats.pendingRateLimitRetries, 0); assert.equal(state.stats.activeResponsesRequests, 0);
});

test('50 persistent rate-limit retries return the last HTTP error and headers unchanged', {timeout: 10000}, async t => {
  let attempts = 0;
  const error = JSON.stringify({error: azureError});
  const {call, health} = await setup(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(429, {'content-type': 'application/json', 'retry-after-ms': '1', 'x-final-error': 'keep'});
    res.end(error);
  });
  const response = await call(); assert.equal(response.status, 429);
  assert.equal(response.headers.get('x-final-error'), 'keep'); assert.equal(await response.text(), error);
  assert.equal(attempts, 51); assert.equal((await health()).stats.rateLimitExhausted, 1);
});

test('wrapped 502 rate-limit error retries, billing errors and unrelated failures pass through once', async t => {
  const attempts = new Map();
  const {call} = await setup(t, (req, res) => {
    req.resume(); const count = (attempts.get(req.url) || 0) + 1; attempts.set(req.url, count);
    let status, error;
    if (req.url.endsWith('wrapped')) {
      status = count === 1 ? 502 : 200;
      error = count === 1 ? azureError : undefined;
    } else if (req.url.endsWith('billing')) { status = 429; error = {code: 'insufficient_quota', message: 'Too many requests: exceeded your current quota.'}; }
    else if (req.url.endsWith('auth')) { status = 403; error = azureError; }
    else { status = 503; error = {message: 'Service unavailable'}; }
    res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(error ? {error} : {ok: true}));
  });
  assert.equal((await call(payload, '/responses?wrapped')).status, 200);
  assert.equal(attempts.get('/responses?wrapped'), 2);
  for (const [kind, status] of [['billing', 429], ['auth', 403], ['unrelated', 503]]) {
    assert.equal((await call(payload, '/responses?' + kind)).status, status);
    assert.equal(attempts.get('/responses?' + kind), 1);
  }
});

test('first SSE rate-limit event retries, then preserves normal output without replaying after response.created', async t => {
  const counts = new Map();
  const {call, health} = await setup(t, (req, res) => {
    req.resume(); const count = (counts.get(req.url) || 0) + 1; counts.set(req.url, count);
    res.writeHead(200, {'content-type': 'text/event-stream'});
    if (req.url.endsWith('late')) {
      res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n'
        + 'event: error\ndata: ' + JSON.stringify({type: 'error', ...azureError}) + '\n\n');
    } else if (count === 1) {
      // An initial comment and split error frame must also be recognized.
      res.write(': upstream heartbeat\n\nevent: response.failed\nda');
      res.end('ta: ' + JSON.stringify({type: 'response.failed', response: {error: azureError}}) + '\n\n');
    } else res.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n');
  });
  const response = await call({...payload, stream: true});
  const text = await response.text();
  assert.equal(response.status, 200); assert.match(text, /^: rate-limit retry pending/);
  assert.match(text, /"delta":"ok"/); assert.doesNotMatch(text, /exceeded token rate limit/);
  assert.equal(counts.get('/responses'), 2);
  assert.equal((await health()).stats.rateLimitRecoveries, 1);
  const late = await call({...payload, stream: true}, '/responses?late');
  assert.match(await late.text(), /exceeded token rate limit/); assert.equal(counts.get('/responses?late'), 1);
});

test('streaming retries exhausted on HTTP rejection return an SSE error, never mixed JSON', async t => {
  let attempts = 0;
  const {call} = await setup(t, (req, res) => {
    req.resume(); attempts++; res.writeHead(429, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: azureError}));
  }, {...fastPolicy, maxRetries: 2});
  const response = await call({...payload, stream: true});
  const text = await response.text();
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.match(text, /event: error\ndata: .*"type":"error"/);
  assert.match(text, /exceeded token rate limit/); assert.equal(attempts, 3);
});

test('recovered compressed SSE after a retry stays readable after plain heartbeat headers', async t => {
  let attempts = 0;
  const event = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"recovered"}\n\n';
  const {call} = await setup(t, (req, res) => {
    req.resume(); attempts++;
    if (attempts === 1) {
      res.writeHead(429, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: azureError}));
    } else {
      res.writeHead(200, {'content-type': 'text/event-stream', 'content-encoding': 'gzip'});
      res.end(zlib.gzipSync(Buffer.from(event)));
    }
  });
  const response = await call({...payload, stream: true});
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(await response.text(), ': rate-limit retry pending\n\n' + event);
  assert.equal(attempts, 2);
});

test('client cancellation during cooldown prevents another upstream request and clears pending stats', {timeout: 5000}, async t => {
  let attempts = 0;
  const {call, health} = await setup(t, (req, res) => {
    req.resume(); attempts++; res.writeHead(429, {'content-type': 'application/json', 'retry-after-ms': '1000'});
    res.end(JSON.stringify({error: azureError}));
  });
  const controller = new AbortController();
  const response = await call({...payload, stream: true}, '/responses', controller.signal);
  const reader = response.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(), /retry pending/);
  controller.abort(); await reader.cancel().catch(() => {});
  for (let i = 0; i < 100 && (await health()).stats.activeResponsesRequests; i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(attempts, 1);
  const state = await health();
  assert.equal(state.stats.pendingRateLimitRetries, 0); assert.equal(state.stats.activeResponsesRequests, 0);
});

test('non-Responses paths never retry even when upstream returns 429', async t => {
  let attempts = 0;
  const {call} = await setup(t, (req, res) => {
    req.resume(); attempts++; res.writeHead(429, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: azureError}));
  });
  assert.equal((await call(payload, '/embeddings')).status, 429); assert.equal(attempts, 1);
});
