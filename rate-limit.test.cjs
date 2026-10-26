'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const {once} = require('node:events');
const {makeProxy, ADMIN} = require('./proxy.cjs');
const {DEFAULT_POLICY, retryDelay, isRateLimit} = require('./rate-limit.cjs');

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

test('first SSE rate-limit event retries, then preserves normal output without replaying after output', async t => {
  const counts = new Map();
  const {call, health} = await setup(t, (req, res) => {
    req.resume(); const count = (counts.get(req.url) || 0) + 1; counts.set(req.url, count);
    res.writeHead(200, {'content-type': 'text/event-stream'});
    if (req.url.endsWith('late')) {
      res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"r1","output":[]}}\n\n'
        + 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"already sent"}\n\n'
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

test('model-independent HTTP detection covers top-level, nested, plain text and JSON error envelopes', async t => {
  const counts = new Map();
  const formats = {
    'azure-502': {status: 502, body: JSON.stringify({message: 'rate limit exceeded: Your requests to gpt-6.1-sol in eastus2 have exceeded token rate limit.'})},
    'nested-200': {status: 200, body: JSON.stringify({data: {error: {type: 'rate_limit_error', message: 'Too many requests for any-model'}}})},
    'code-200': {status: 200, body: JSON.stringify({code: 'rate_limit_exceeded', message: 'Any model is throttled.'})},
    'text-503': {status: 503, type: 'text/plain', body: 'Token rate limit exceeded for another-model'},
    'problem-json': {status: 200, type: 'application/problem+json', body: JSON.stringify({error: {message: 'rate_limit_exceeded'}})}
  };
  const {call, health} = await setup(t, (req, res) => {
    req.resume(); const key = req.url.split('?')[1];
    const count = (counts.get(key) || 0) + 1; counts.set(key, count);
    const format = formats[key];
    res.writeHead(count === 1 ? format.status : 200, {'content-type': format.type || 'application/json'});
    res.end(count === 1 ? format.body : JSON.stringify({ok: true}));
  });
  for (const key of Object.keys(formats)) {
    assert.deepEqual(await (await call({...payload, model: key}, '/responses?' + key)).json(), {ok: true});
    assert.equal(counts.get(key), 2);
  }
  assert.equal((await health()).stats.rateLimitRecoveries, 5);
});

test('compressed SSE prelude can be discarded and retried before output, without leaking rejected response IDs', async t => {
  const counts = new Map();
  const encode = {gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync, zstd: zlib.zstdCompressSync};
  const {call, health} = await setup(t, (req, res) => {
    req.resume(); const encoding = req.url.split('?')[1];
    const count = (counts.get(encoding) || 0) + 1; counts.set(encoding, count);
    const id = count === 1 ? 'rejected-id' : 'accepted-id';
    const prelude = 'event: response.created\ndata: ' + JSON.stringify({type:'response.created', response:{id, output:[]}}) + '\n\n'
      + 'event: response.in_progress\ndata: ' + JSON.stringify({type:'response.in_progress', response:{id, output:[]}}) + '\n\n';
    const text = prelude + (count === 1
      ? 'event: error\ndata: ' + JSON.stringify({message:'rate limit exceeded: any model is throttled'}) + '\n\n'
      : 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"recovered"}\n\n');
    res.writeHead(200, {'content-type':'text/event-stream', 'content-encoding':encoding});
    res.end(encode[encoding](Buffer.from(text)));
  });
  for (const encoding of Object.keys(encode)) {
    const response = await call({...payload, stream:true}, '/responses?' + encoding);
    const text = await response.text();
    assert.equal(response.headers.get('content-encoding'), null);
    assert.match(text, /accepted-id/); assert.match(text, /recovered/);
    assert.doesNotMatch(text, /rejected-id|rate limit exceeded/);
    assert.equal(counts.get(encoding), 2);
  }
  assert.equal((await health()).stats.rateLimitRecoveries, 4);
});

test('SSE error arriving after the old sniff timeout is retried; split prelude is preserved only on recovery', async t => {
  let attempts = 0;
  const {call} = await setup(t, (req, res) => {
    req.resume(); attempts++;
    res.writeHead(200, {'content-type':'text/event-stream', 'content-encoding':'identity'});
    res.write(': heartbeat\n\nevent: response.created\ndata: {"type":"response.created","response":{"id":"');
    res.write(attempts === 1 ? 'reject' : 'accept');
    res.write('","output":[]}}\n\n');
    if (attempts === 1) setTimeout(() => res.end('event: error\ndata: ' + JSON.stringify({type:'error', ...azureError}) + '\n\n'), 35);
    else res.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n');
  }, {...fastPolicy, sniffTimeoutMs:5});
  const text = await (await call({...payload, stream:true})).text();
  assert.equal(attempts, 2); assert.match(text, /accept/); assert.doesNotMatch(text, /reject|exceeded token rate limit/);
});

test('normal output mentioning rate limits and real tool execution are never replayed', async t => {
  const counts = new Map();
  const {call} = await setup(t, (req, res) => {
    req.resume(); const key = req.url.split('?')[1]; counts.set(key, (counts.get(key) || 0) + 1);
    if (key === 'json') {
      res.writeHead(200, {'content-type':'application/json'});
      return res.end(JSON.stringify({id:'ok', output:[{content:[{text:'rate_limit_exceeded means too many requests'}]}]}));
    }
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"tool","output":[]}}\n\n'
      + 'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call-1"}}\n\n'
      + 'event: error\ndata: ' + JSON.stringify({type:'error', ...azureError}) + '\n\n');
  });
  assert.match(await (await call(payload, '/responses?json')).text(), /rate_limit_exceeded/);
  assert.match(await (await call({...payload, stream:true}, '/responses?tool')).text(), /call-1/);
  assert.deepEqual([...counts.values()], [1, 1]);
});

test('generic classification still excludes authentication and billing errors', () => {
  assert.equal(isRateLimit({type:'throttling_error', message:'slow down'}, 503), true);
  assert.equal(isRateLimit('rate limit exceeded for model-that-did-not-exist-in-tests', 502), true);
  assert.equal(isRateLimit({code:'invalid_api_key', message:'rate limit exceeded'}, 502), false);
  assert.equal(isRateLimit({error:{code:'insufficient_quota', message:'too many requests'}}, 429), false);
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
