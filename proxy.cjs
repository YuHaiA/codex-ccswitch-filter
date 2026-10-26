'use strict';

const http = require('node:http');
const zlib = require('node:zlib');
const {timingSafeEqual} = require('node:crypto');
const {DEFAULT_POLICY, forwardResponses} = require('./rate-limit.cjs');
const SERVICE = 'ccswitch-codex-reasoning-filter-v1';
const FILTER_VERSION = 4;
const ADMIN = '/__codex_filter__';
const LIMIT = 64 * 1024 * 1024;
// These input forms carry their own contents; the server-issued item id is optional.
// Other tool/resource types may require their IDs, so don't recursively strip IDs.
const PORTABLE_ITEMS = new Set(['message', 'function_call', 'function_call_output',
  'custom_tool_call', 'custom_tool_call_output']);
// Hosted web search records are bound to the resource that ran them and require the dropped reasoning item.
// Their results already live in later assistant messages, so drop them from history instead of replaying.
const DROPPED_ITEMS = new Set(['web_search_call']);

class FilterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function filterResponsesRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FilterError('invalid_request_json', 'Responses request must be a JSON object.');
  }
  if (body.previous_response_id || body.conversation) {
    throw new FilterError('response_reference_not_portable',
      'Complete message/tool history is required, not previous_response_id or conversation references. Start a new session with a text summary.');
  }
  if (body.include !== undefined && !Array.isArray(body.include)) {
    throw new FilterError('invalid_include', 'include must be an array.');
  }
  if (body.input !== undefined && typeof body.input !== 'string' && !Array.isArray(body.input)) {
    throw new FilterError('invalid_input', 'input must be a string or an array.');
  }
  if (Array.isArray(body.context_management) && body.context_management.some(item => item?.type === 'compaction')) {
    throw new FilterError('encrypted_compaction_disabled',
      'Encrypted compaction is disabled by this filter. Use a text summary and start a new session.');
  }
  const clean = {...body, store: false};
  let removed = 0, removedItemIds = 0, removedHostedItems = 0;
  if (body.include) clean.include = body.include.filter(value => value !== 'reasoning.encrypted_content');
  if (Array.isArray(body.input)) {
    clean.input = body.input.filter(item => {
      if (item?.type === 'reasoning') { removed++; return false; }
      if (DROPPED_ITEMS.has(item?.type)) { removedHostedItems++; return false; }
      return true;
    });
    clean.input = clean.input.map(item => {
      if (item?.type === 'compaction' || item?.type === 'item_reference' || item?.encrypted_content) {
        throw new FilterError('encrypted_context_not_portable',
          'Encrypted compaction/context references cannot safely cross accounts. Start a new session with a text summary; history has NOT been silently discarded.');
      }
      const isMessage = item && item.type === undefined && typeof item.role === 'string' && item.content !== undefined;
      if (item && (PORTABLE_ITEMS.has(item.type) || isMessage) && Object.hasOwn(item, 'id')) {
        const portable = {...item};
        delete portable.id;
        removedItemIds++;
        return portable;
      }
      return item;
    });
  }
  // call_id pairs calls/results and is not the server-side item id.
  // Preserve it, this turn's effort, all message contents, and nested resource IDs.
  return {body: clean, removed, removedItemIds, removedHostedItems};
}

// Content-free outline of a request for diagnosing upstream 4xx: keys, item types, ID prefixes. No text, no secrets.
function requestShape(body) {
  const ids = [];
  const walk = (value, at) => {
    if (Array.isArray(value)) value.forEach((entry, i) => walk(entry, at + '[' + i + ']'));
    else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string' && /(^|_)id$|_ids?$|^encrypted_content$/.test(key) && key !== 'call_id')
        ids.push(at + '.' + key + '=' + entry.slice(0, 4));
      else walk(entry, at + '.' + key);
    }
  };
  walk(body, '');
  return {keys: Object.keys(body || {}), input: Array.isArray(body?.input) ? body.input.map(item => item?.type || (item?.role ? 'role:' + item.role : typeof item)) : typeof body?.input,
    ids: ids.slice(0, 40)};
}

function localOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Upstream must be a loopback HTTP origin, such as http://127.0.0.1:15721');
  }
  return url.origin;
}

function cleanHeaders(headers) {
  const clean = {...headers};
  const named = String(clean.connection || '').split(',').map(value => value.trim().toLowerCase());
  for (const key of [...named, 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade']) delete clean[key];
  return clean;
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  // Keep the socket open so oversized requests can receive JSON 413.
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new FilterError('request_too_large', 'Request exceeds filter size limit.', 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function decodeBody(buffer, encoding, limit) {
  const options = {maxOutputLength: limit};
  try {
    switch (String(encoding || 'identity').toLowerCase()) {
      case 'identity': return buffer;
      case 'gzip': return zlib.gunzipSync(buffer, options);
      case 'deflate': return zlib.inflateSync(buffer, options);
      case 'br': return zlib.brotliDecompressSync(buffer, options);
      case 'zstd': return zlib.zstdDecompressSync(buffer, options);
      default: throw new FilterError('unsupported_content_encoding', 'Unsupported request Content-Encoding.', 415);
    }
  } catch (error) {
    if (error instanceof FilterError) throw error;
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new FilterError('request_too_large', 'Decoded request exceeds filter size limit.', 413);
    throw new FilterError('invalid_compressed_request', 'Cannot decode compressed request.');
  }
}

function sendError(res, error) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(error.status || 502, {'content-type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify({error: {type: 'invalid_request_error', code: error.code || 'local_filter_error', message: error.message}}));
}

function makeProxy({getUpstream, token, onStop = () => {}, getState = () => ({}), log = () => {}, limit = LIMIT, retryPolicy}) {
  const stats = {requests: 0, filteredRequests: 0, removedReasoningItems: 0, removedItemIds: 0, removedHostedItems: 0,
    blockedRequests: 0, upstreamErrors: 0, upstreamHttpErrors: 0, lastFilteredAt: null, lastUpstreamStatus: null,
    activeResponsesRequests: 0, rateLimitErrors: 0, rateLimitRetries: 0, rateLimitRecoveries: 0,
    rateLimitExhausted: 0, pendingRateLimitRetries: 0};
  const server = http.createServer(async (req, res) => {
    let upstreamRequest;
    const controller = new AbortController();
    const cancel = () => {
      controller.abort(new Error('client_canceled'));
      upstreamRequest?.destroy();
    };
    req.once('aborted', cancel);
    res.once('close', () => { if (!res.writableFinished) cancel(); });
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
        throw new FilterError('invalid_target', 'Only origin-form HTTP requests are accepted.');
      }
      const route = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      if (req.headers.origin || req.headers['sec-fetch-site']) {
        throw new FilterError('browser_request_rejected', 'Browser requests are not supported.', 403);
      }
      if (route === ADMIN + '/health' && req.method === 'GET') {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({service: SERVICE, filterVersion: FILTER_VERSION, pid: process.pid, stats,
          rateLimitMaxRetries: retryPolicy?.maxRetries ?? DEFAULT_POLICY.maxRetries, ...getState()}));
        return;
      }
      if (route.startsWith(ADMIN)) {
        const given = Buffer.from(String(req.headers['x-filter-token'] || ''));
        const expected = Buffer.from(String(token || ''));
        if (!expected.length || expected.length !== given.length || !timingSafeEqual(given, expected)) {
          throw new FilterError('invalid_control_token', 'Invalid local control token.', 403);
        }
        if (route !== ADMIN + '/stop' || req.method !== 'POST') throw new FilterError('unknown_control_route', 'Unknown control route.', 404);
        await onStop();
        res.writeHead(200, {'content-type': 'application/json'});
        res.end('{"stopping":true}');
        return;
      }
      if (/\/responses\/compact\/?$/.test(route)) {
        throw new FilterError('encrypted_compaction_disabled',
          'Encrypted Responses compaction is disabled. Use a text summary and start a new session.', 409);
      }
      const upstream = new URL(localOrigin(getUpstream()));
      if (Number(upstream.port || 80) === server.address().port) throw new FilterError('proxy_loop', 'CC Switch and filter must use different ports.', 503);
      const headers = cleanHeaders(req.headers);
      headers.host = upstream.host;
      let body, shape, stream;
      const isResponses = /\/responses\/?$/.test(route) && req.method === 'POST';
      if (isResponses) {
        const raw = decodeBody(await readBody(req, limit), req.headers['content-encoding'], limit);
        let input;
        try { input = JSON.parse(raw.toString('utf8')); }
        catch { throw new FilterError('invalid_request_json', 'Responses request is not valid JSON.'); }
        const filtered = filterResponsesRequest(input);
        body = Buffer.from(JSON.stringify(filtered.body));
        delete headers['content-encoding'];
        delete headers.expect;
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(body.length);
        stats.filteredRequests++;
        stats.removedReasoningItems += filtered.removed;
        stats.removedItemIds += filtered.removedItemIds;
        stats.removedHostedItems += filtered.removedHostedItems;
        stats.lastFilteredAt = new Date().toISOString();
        log('filtered', {removed: filtered.removed, removedItemIds: filtered.removedItemIds, removedHostedItems: filtered.removedHostedItems});
        shape = requestShape(filtered.body);
        stream = filtered.body.stream === true;
      }
      if (res.destroyed || req.aborted) return;
      stats.requests++;
      if (isResponses) {
        try {
          await forwardResponses({getUpstream: () => {
            const origin = localOrigin(getUpstream());
            if (Number(new URL(origin).port || 80) === server.address().port)
              throw new FilterError('proxy_loop', 'CC Switch and filter must use different ports.', 503);
            return origin;
          }, path: req.url, headers, body, stream, res, signal: controller.signal, stats, log, shape, cleanHeaders, policy: retryPolicy});
        } catch (error) {
          if (controller.signal.aborted || res.destroyed) return;
          stats.upstreamErrors++;
          log('upstream-error', {code: error.code || 'upstream_response_error'});
          sendError(res, error instanceof FilterError ? error : new FilterError('ccswitch_unavailable',
            'Cannot reach CC Switch. Enable its local proxy and Codex takeover, then retry.', 502));
        }
        return;
      }
      upstreamRequest = http.request({hostname: upstream.hostname.replace(/^\[|\]$/g, ''), port: upstream.port || 80,
        path: req.url, method: req.method, headers}, upstreamResponse => {
        if (res.destroyed) { upstreamResponse.destroy(); return; }
        res.writeHead(upstreamResponse.statusCode, cleanHeaders(upstreamResponse.headers));
        res.flushHeaders();
        upstreamResponse.on('error', () => res.destroy());
        upstreamResponse.on('aborted', () => res.destroy());
        upstreamResponse.pipe(res);
      });
      // Other routes are passed through once. Responses retries only explicit
      // rate-limit rejections before output/tool events are committed.
      upstreamRequest.setTimeout(600000, () => upstreamRequest.destroy(new Error('upstream_timeout')));
      upstreamRequest.on('error', error => {
        if (res.destroyed) return;
        stats.upstreamErrors++;
        log('upstream-error', {code: error.code || 'timeout'});
        sendError(res, new FilterError('ccswitch_unavailable', 'Cannot reach CC Switch. Enable its local proxy and Codex takeover, then retry.', 502));
      });
      if (body) upstreamRequest.end(body);
      else req.pipe(upstreamRequest);
    } catch (error) {
      stats.blockedRequests++;
      log('blocked', {code: error.code || 'filter_error'});
      sendError(res, error instanceof FilterError ? error : new FilterError('local_filter_error', 'Local filter failed to handle request.', 500));
    }
  });
  server.on('upgrade', (req, socket) => {
    const body = 'Use Responses over HTTP/SSE; WebSocket filtering is not supported.';
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: '
      + Buffer.byteLength(body) + '\r\n\r\n' + body);
  });
  server.requestTimeout = 120000;
  return server;
}

module.exports = {SERVICE, ADMIN, FilterError, filterResponsesRequest, requestShape, localOrigin, makeProxy, decodeBody};
