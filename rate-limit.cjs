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

function errorDetails(value, failure = false, depth = 0) {
  if (value == null || depth > 6) return null;
  if (typeof value !== 'object') return failure ? value : null;
  if (value.error != null) return value.error;
  if (value.response?.error != null) return value.response.error;
  if (value.type === 'response.failed' || value.status === 'failed')
    return value.response?.error || value.error || {code: value.code, message: value.message || 'Response failed.'};
  if (value.type === 'error' || /_error$/.test(value.type || '')) return value;
  // Some gateways put error code/message at the top level even with HTTP 200.
  // Never classify normal generated output by searching its full JSON text.
  if (value.code != null && typeof value.message === 'string' && isRateLimit({code: value.code, message: value.message}))
    return {code: value.code, message: value.message};
  for (const key of ['data', 'body', 'detail', 'details', 'cause', 'innererror', 'inner_error']) {
    if (!value[key] || typeof value[key] !== 'object') continue;
    const error = errorDetails(value[key], false, depth + 1);
    if (error) return error;
  }
  // A failed HTTP response may use any envelope, including a bare message.
  return failure ? value : null;
}

function isRateLimit(error, status) {
  const text = typeof error === 'string' ? error : JSON.stringify(error || {});
  if (status === 401 || status === 403) return false;
  if (/authentication_error|invalid_api_key|unauthorized|permission_denied|access_denied/i.test(text)) return false;
  if (/insufficient[_ ]quota|billing[_ ]hard[_ ]limit|quota[_ ]exceeded|credit_balance_exhausted|(?:spend|usage)_limit_exceeded|credits? (?:exhausted|balance)|insufficient (?:funds|balance)|exceeded your current quota/i.test(text)) return false;
  return status === 429 || /rate[_ -]?limit(?:[_ -]exceeded|[_ -]error|[_ -]reached)?|token rate limit|too many requests|\bslow_down\b|\bthrottl(?:ed|ing)(?:_error)?\b/i.test(text);
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

function streamDecoder(encoding) {
  switch (String(encoding || 'identity').toLowerCase()) {
    case 'gzip': return zlib.createGunzip();
    case 'deflate': return zlib.createInflate();
    case 'br': return zlib.createBrotliDecompress();
    case 'zstd': return zlib.createZstdDecompress();
    case 'identity': return null;
    default: return undefined;
  }
}

// Buffer only the SSE prelude. Metadata is not sent to the client until we see
// output or a tool event. An explicit rejection before that point can be retried
// without sending mixed response IDs or duplicate output to the client.
function probe(response, policy, signal) {
  const status = response.statusCode;
  const sse = /text\/event-stream/i.test(String(response.headers['content-type'] || ''));
  const json = /(?:application\/json|\+json)/i.test(String(response.headers['content-type'] || ''));
  let source = response, headers = response.headers;
  if (sse && response.headers['content-encoding']) {
    const decoder = streamDecoder(response.headers['content-encoding']);
    if (decoder === undefined) return Promise.resolve({prefix: Buffer.alloc(0), retry: false,
      source, headers, reason: 'unsupported-encoding'});
    if (decoder) {
      headers = {...headers}; delete headers['content-encoding']; delete headers['content-length'];
      source = decoder;
      response.pipe(decoder);
    }
  }
  if (status < 400 && !sse && !json) return Promise.resolve({prefix: Buffer.alloc(0), retry: false,
    source, headers, reason: 'non-error-response'});
  return new Promise((resolve, reject) => {
    let prefix = Buffer.alloc(0), scanned = 0, timer, settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      source.off('data', data); source.off('end', end); source.off('error', fail);
      response.off('error', fail); response.off('aborted', aborted);
      signal.removeEventListener('abort', canceled);
    };
    const done = result => {
      if (settled) return;
      settled = true; source.pause(); cleanup();
      resolve({prefix, retry: false, source, headers, ...result});
    };
    const fail = error => {
      if (settled) return;
      settled = true; cleanup(); if (source !== response) source.destroy(); reject(error);
    };
    const aborted = () => fail(new Error('upstream_response_aborted'));
    const canceled = () => { fail(signal.reason); response.destroy(); };
    const frameResult = frame => {
      const lines = frame.split(/\r?\n/);
      const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
      const payload = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!payload) return null;
      const errorEvent = /^(?:error|rate_limit_error|response.failed)$/.test(event || '');
      let value;
      try { value = JSON.parse(payload); }
      catch { return {retry: errorEvent && isRateLimit(payload, status), error: errorEvent ? payload : null, reason: 'unparsed-event'}; }
      const error = errorDetails(value, errorEvent || status >= 400);
      if (error) return {retry: isRateLimit(error, status), error, reason: 'error-event'};
      const type = value?.type || event;
      if (['response.created', 'response.in_progress'].includes(type)
          && value.response && Array.isArray(value.response.output) && value.response.output.length === 0
          && !value.response.required_input) return null;
      // Unknown events and every output/tool/reasoning event commit the stream.
      return {reason: 'stream-committed'};
    };
    const end = () => {
      if (sse) return done(frameResult(prefix.toString('utf8').slice(scanned)) || {reason: 'stream-ended'});
      const decoded = decodeError(prefix, headers, policy.maxErrorBytes);
      if (!decoded) return done({reason: 'undecodable-error'});
      let error;
      try { error = errorDetails(JSON.parse(decoded.toString('utf8')), status >= 400); }
      catch { error = status >= 400 ? decoded.toString('utf8') : null; }
      done({retry: (status >= 400 || !!error) && isRateLimit(error, status), error, reason: 'http-body'});
    };
    const data = chunk => {
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.length > policy.maxErrorBytes) return done({reason: 'probe-byte-limit'});
      if (!sse) return;
      const text = prefix.toString('utf8');
      let match;
      const boundary = /\r?\n\r?\n/g;
      boundary.lastIndex = scanned;
      while ((match = boundary.exec(text))) {
        const frame = text.slice(scanned, match.index);
        scanned = boundary.lastIndex;
        const result = frameResult(frame);
        if (result) return done(result);
      }
    };
    // Do not stop inspecting an SSE prelude after five seconds. Keep it alive
    // until output, rejection, end, the bounded byte limit or client cancellation.
    if (!sse) timer = setTimeout(() => done({reason: 'probe-timeout'}), policy.sniffTimeoutMs);
    source.on('data', data); source.once('end', end); source.once('error', fail);
    if (source !== response) response.once('error', fail);
    response.once('aborted', aborted);
    signal.addEventListener('abort', canceled, {once: true});
    if (signal.aborted) canceled();
    else source.resume();
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

function pipeResponse(response, res, result, signal, cleanHeaders) {
  return new Promise((resolve, reject) => {
    const {prefix, source, headers} = result;
    let decoder;
    const cleanup = () => {
      signal.removeEventListener('abort', canceled);
      response.off('error', fail); response.off('aborted', aborted); res.off('finish', finished);
      source.off('error', fail);
      decoder?.off('error', fail);
    };
    const finished = () => { cleanup(); resolve(); };
    const fail = error => { cleanup(); decoder?.destroy(); if (source !== response) source.destroy(); response.destroy(); reject(error); };
    const aborted = () => fail(new Error('upstream_response_aborted'));
    const canceled = () => { fail(signal.reason); response.destroy(); };
    response.on('error', fail); response.once('aborted', aborted); res.once('finish', finished);
    if (source !== response) source.on('error', fail);
    signal.addEventListener('abort', canceled, {once: true});
    if (signal.aborted) return canceled();
    // A retry heartbeat already committed plain SSE headers. If an upstream
    // compresses the recovered stream, decompress it before forwarding.
    if (res.headersSent && headers['content-encoding']) {
      decoder = streamDecoder(headers['content-encoding']);
      if (decoder === undefined) return fail(new Error('unsupported_upstream_encoding'));
    }
    if (!res.headersSent) { res.writeHead(response.statusCode, cleanHeaders(headers)); res.flushHeaders(); }
    const target = decoder || res;
    if (decoder) { decoder.on('error', fail); decoder.pipe(res); }
    if (prefix.length) target.write(prefix);
    if (source.readableEnded) target.end();
    else source.pipe(target);
  });
}

async function forwardResponses({getUpstream, path, headers, body, stream, res, signal, stats, log, shape, cleanHeaders, policy: overrides}) {
  const policy = {...DEFAULT_POLICY, ...overrides};
  let retries = 0, heartbeat;
  stats.activeResponsesRequests++;
  const keepAlive = () => {
    if (!stream || res.destroyed || res.writableEnded) return;
    if (!res.headersSent) res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store',
      'x-filter-max-retries': String(policy.maxRetries)});
    res.write(': filter waiting for upstream\n\n');
  };
  if (stream) heartbeat = setInterval(keepAlive, 15000);
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
      if (['probe-timeout', 'probe-byte-limit', 'unsupported-encoding', 'undecodable-error'].includes(result.reason))
        log('rate-limit-probe-bypassed', {reason: result.reason, status: response.statusCode});
      if (result.retry) {
        stats.rateLimitErrors++;
        if (retries < policy.maxRetries) {
          const delayMs = retryDelay(response.headers, retries + 1, policy);
          response.destroy();
          if (result.source !== response) result.source.destroy();
          retries++;
          stats.rateLimitRetries++;
          stats.pendingRateLimitRetries++;
          log('rate-limit-retry', {retry: retries, maxRetries: policy.maxRetries, delayMs, status: response.statusCode, detectedBy: result.reason});
          // SSE comments keep a streaming client connected without inventing model output.
          if (stream && !res.headersSent) {
            res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-filter-max-retries': String(policy.maxRetries)});
            res.write(': rate-limit retry pending\n\n');
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
      } else await pipeResponse(response, res, result, signal, cleanHeaders);
      return;
    }
  } finally { clearInterval(heartbeat); stats.activeResponsesRequests--; }
}

module.exports = {DEFAULT_POLICY, retryDelay, isRateLimit, forwardResponses};
