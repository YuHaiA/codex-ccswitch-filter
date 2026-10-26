'use strict';

const http = require('node:http');
const zlib = require('node:zlib');

const DEFAULT_POLICY = Object.freeze({maxRetries: 50, baseDelayMs: 5000, maxDelayMs: 60000,
  minDelayMs: 1000, sniffTimeoutMs: 5000, maxErrorBytes: 65536, random: Math.random, now: Date.now});

function retryDelay(headers, retry, policy = DEFAULT_POLICY) {
  const waits = [];
  for (const key of ['retry-after-ms', 'x-ms-retry-after-ms']) {
    if (headers[key] !== undefined && Number.isFinite(Number(headers[key])) && Number(headers[key]) >= 0)
      waits.push(Number(headers[key]));
  }
  if (headers['retry-after'] !== undefined) {
    const value = String(headers['retry-after']);
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) waits.push(seconds * 1000);
    else {
      const date = Date.parse(value);
      if (Number.isFinite(date)) waits.push(Math.max(0, date - policy.now()));
    }
  }
  for (const kind of ['tokens', 'requests']) {
    if (String(headers['x-ratelimit-remaining-' + kind]) !== '0') continue;
    const value = String(headers['x-ratelimit-reset-' + kind] || '');
    if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(value)) continue;
    let total = 0;
    for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g))
      total += Number(match[1]) * ({ms: 1, s: 1000, m: 60000, h: 3600000}[match[2]]);
    waits.push(total);
  }
  const fallback = Math.min(policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.min(retry - 1, 10)) * (1 - policy.random() * 0.1);
  // Never shorten a valid server cooldown to our exponential-backoff ceiling.
  return Math.ceil(Math.max(policy.minDelayMs, waits.length ? Math.max(...waits) : fallback));
}

function errorDetails(value) {
  if (value?.error !== undefined) return value.error;
  if (value?.type === 'response.failed') return value.response?.error;
  if (value?.type === 'error' || value?.type === 'rate_limit_error') return value;
  return null;
}

function isRateLimit(error, status) {
  const text = typeof error === 'string' ? error : JSON.stringify(error || {});
  if (status === 401 || status === 403) return false;
  if (/insufficient[_ ]quota|billing[_ ]hard[_ ]limit|quota[_ ]exceeded|credit_balance_exhausted|(?:spend|usage)_limit_exceeded|credits? (?:exhausted|balance)|insufficient (?:funds|balance)|exceeded your current quota/i.test(text)) return false;
  return status === 429 || /rate[_ -]?limit(?:[_ -]exceeded|[_ -]error|[_ -]reached)?|token rate limit|too many requests|\bslow_down\b/i.test(text);
}

function decodeError(buffer, headers, limit) {
  const options = {maxOutputLength: limit};
  try {
    switch (String(headers['content-encoding'] || 'identity').toLowerCase()) {
      case 'gzip': return zlib.gunzipSync(buffer, options);
      case 'deflate': return zlib.inflateSync(buffer, options);
      case 'br': return zlib.brotliDecompressSync(buffer, options);
      case 'zstd': return zlib.zstdDecompressSync(buffer, options);
      case 'identity': return buffer;
      default: return null;
    }
  } catch { return null; }
}

// Inspect only HTTP errors or the first meaningful SSE event. Once a normal event
// is seen (including response.created), commit the stream and never replay it.
function probe(response, policy, signal) {
  const status = response.statusCode;
  const sse = /text\/event-stream/i.test(String(response.headers['content-type'] || ''))
    && !response.headers['content-encoding'];
  const json = /application\/json/i.test(String(response.headers['content-type'] || ''));
  if (status < 400 && !sse && !json) return Promise.resolve({prefix: Buffer.alloc(0), retry: false});
  return new Promise((resolve, reject) => {
    let prefix = Buffer.alloc(0), scanned = 0;
    const cleanup = () => {
      clearTimeout(timer);
      response.off('data', data); response.off('end', end);
      response.off('error', fail); response.off('aborted', aborted);
      signal.removeEventListener('abort', canceled);
    };
    const done = result => { response.pause(); cleanup(); resolve({prefix, retry: false, ...result}); };
    const fail = error => { cleanup(); reject(error); };
    const aborted = () => fail(new Error('upstream_response_aborted'));
    const canceled = () => { fail(signal.reason); response.destroy(); };
    const end = () => {
      if (sse && status < 400) return done({});
      const decoded = decodeError(prefix, response.headers, policy.maxErrorBytes);
      if (!decoded) return done({});
      let error;
      try { error = errorDetails(JSON.parse(decoded.toString('utf8'))); }
      catch { error = decoded.toString('utf8'); }
      done({retry: (status >= 400 || !!error) && isRateLimit(error, status), error});
    };
    const data = chunk => {
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.length > policy.maxErrorBytes) return done({});
      if (!sse || status >= 400) return;
      const text = prefix.toString('utf8');
      let match;
      const boundary = /\r?\n\r?\n/g;
      boundary.lastIndex = scanned;
      while ((match = boundary.exec(text))) {
        const frame = text.slice(scanned, match.index);
        scanned = boundary.lastIndex;
        const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (!payload) continue;
        let error;
        try { error = errorDetails(JSON.parse(payload)); }
        catch { return done({}); }
        return done({retry: !!error && isRateLimit(error, 200), error});
      }
    };
    const timer = setTimeout(() => done({}), policy.sniffTimeoutMs);
    response.on('data', data); response.once('end', end);
    response.once('error', fail); response.once('aborted', aborted);
    signal.addEventListener('abort', canceled, {once: true});
    if (signal.aborted) canceled();
    else response.resume();
  });
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason); };
    const tick = remaining => {
      const part = Math.min(remaining, 2147483647);
      timer = setTimeout(() => {
        if (remaining > part) tick(remaining - part);
        else { signal.removeEventListener('abort', aborted); resolve(); }
      }, part);
    };
    signal.addEventListener('abort', aborted, {once: true});
    if (signal.aborted) aborted(); else tick(ms);
  });
}

function request(options, body, signal) {
  return new Promise((resolve, reject) => {
    const req = http.request(options);
    const aborted = () => req.destroy(signal.reason);
    req.setTimeout(600000, () => req.destroy(new Error('upstream_timeout')));
    req.once('error', reject);
    req.once('close', () => signal.removeEventListener('abort', aborted));
    req.once('response', response => { response.pause(); resolve(response); });
    signal.addEventListener('abort', aborted, {once: true});
    if (signal.aborted) aborted(); else req.end(body);
  });
}

function pipeResponse(response, res, prefix, signal, cleanHeaders) {
  return new Promise((resolve, reject) => {
    let decoder;
    const cleanup = () => {
      signal.removeEventListener('abort', canceled);
      response.off('error', fail); response.off('aborted', aborted); res.off('finish', finished);
      decoder?.off('error', fail);
    };
    const finished = () => { cleanup(); resolve(); };
    const fail = error => { cleanup(); decoder?.destroy(); response.destroy(); reject(error); };
    const aborted = () => fail(new Error('upstream_response_aborted'));
    const canceled = () => { fail(signal.reason); response.destroy(); };
    response.on('error', fail); response.once('aborted', aborted); res.once('finish', finished);
    signal.addEventListener('abort', canceled, {once: true});
    if (signal.aborted) return canceled();
    // A retry heartbeat already committed plain SSE headers. If an upstream
    // compresses the recovered stream, decompress it before forwarding.
    if (res.headersSent && response.headers['content-encoding']) {
      switch (String(response.headers['content-encoding']).toLowerCase()) {
        case 'gzip': decoder = zlib.createGunzip(); break;
        case 'deflate': decoder = zlib.createInflate(); break;
        case 'br': decoder = zlib.createBrotliDecompress(); break;
        case 'zstd': decoder = zlib.createZstdDecompress(); break;
        case 'identity': break;
        default: return fail(new Error('unsupported_upstream_encoding'));
      }
    }
    if (!res.headersSent) { res.writeHead(response.statusCode, cleanHeaders(response.headers)); res.flushHeaders(); }
    const target = decoder || res;
    if (decoder) { decoder.on('error', fail); decoder.pipe(res); }
    if (prefix.length) target.write(prefix);
    if (response.readableEnded) target.end();
    else response.pipe(target);
  });
}

async function forwardResponses({getUpstream, path, headers, body, stream, res, signal, stats, log, shape, cleanHeaders, policy: overrides}) {
  const policy = {...DEFAULT_POLICY, ...overrides};
  let retries = 0, heartbeat;
  stats.activeResponsesRequests++;
  try {
    for (;;) {
      signal.throwIfAborted();
      const upstream = new URL(getUpstream());
      const response = await request({hostname: upstream.hostname.replace(/^\[|\]$/g, ''),
        port: upstream.port || 80, path, method: 'POST', headers: {...headers, host: upstream.host}}, body, signal);
      stats.lastUpstreamStatus = response.statusCode;
      if (response.statusCode >= 400) {
        stats.upstreamHttpErrors++;
        log('upstream-http-error', {status: response.statusCode, ...(response.statusCode < 500 && shape ? {shape} : {})});
      }
      const result = await probe(response, policy, signal);
      if (result.retry) {
        stats.rateLimitErrors++;
        if (retries < policy.maxRetries) {
          const delayMs = retryDelay(response.headers, retries + 1, policy);
          response.destroy();
          retries++;
          stats.rateLimitRetries++;
          stats.pendingRateLimitRetries++;
          log('rate-limit-retry', {retry: retries, maxRetries: policy.maxRetries, delayMs, status: response.statusCode});
          // SSE comments keep a streaming client connected without inventing model output.
          if (stream && !res.headersSent) {
            res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-filter-max-retries': String(policy.maxRetries)});
            res.write(': rate-limit retry pending\n\n');
            heartbeat = setInterval(() => { if (!res.destroyed) res.write(': rate-limit retry pending\n\n'); }, 15000);
          }
          try { await wait(delayMs, signal); }
          finally { stats.pendingRateLimitRetries--; }
          continue;
        }
        stats.rateLimitExhausted++;
        log('rate-limit-exhausted', {retries, status: response.statusCode});
      } else if (retries && response.statusCode < 400 && !result.error) {
        stats.rateLimitRecoveries++;
        log('rate-limit-recovered', {retries});
      }
      clearInterval(heartbeat);
      if (res.headersSent && !/text\/event-stream/i.test(String(response.headers['content-type'] || ''))) {
        // A streamed retry already sent SSE comments; relay the final failure as
        // a real SSE error instead of mixing HTTP JSON with the event stream.
        const error = result.error || {code: 'upstream_protocol_mismatch', message: 'Upstream returned a non-stream response after retry.'};
        const value = typeof error === 'string' ? {message: error} : error;
        res.end('event: error\ndata: ' + JSON.stringify({...value, type: 'error'}) + '\n\n');
        response.destroy();
      } else await pipeResponse(response, res, result.prefix, signal, cleanHeaders);
      return;
    }
  } finally { clearInterval(heartbeat); stats.activeResponsesRequests--; }
}

module.exports = {DEFAULT_POLICY, retryDelay, isRateLimit, forwardResponses};
