import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Queue } from './queue.js';
import { BridgeError, callUpstream, callDirectEdit } from './upstream.js';
import { emitResponse, eventWriter, writeFrame } from './events.js';
import { imageInputPresent, materializeDirectEdit, parseDirectEdit, wrapDirectEdit } from './direct-edits.js';
import { describeRequest } from './request-format.js';

function sendJSON(res, status, data) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const publicAPIPaths = new Set(['/v1/responses', '/responses', '/v1/models', '/models']);
function enableAPICORS(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || 'Authorization, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'X-Bridge-Request-Id, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export async function readJSON(req, maxBytes, capture) {
  let length = 0;
  const chunks = [];
  // Do not destroy the request via an async iterator on validation failure:
  // the caller still needs to be able to send a useful 413 response.
  await new Promise((resolve, reject) => {
    function cleanup() {
      req.off('data', data);
      req.off('end', end);
      req.off('error', error);
      req.off('aborted', aborted);
    }
    function data(chunk) {
      length += chunk.length;
      if (length > maxBytes) {
        cleanup();
        req.resume();
        reject(new BridgeError(413, 'request_too_large', 'Request body exceeded the configured size limit'));
      } else chunks.push(chunk);
    }
    function end() { cleanup(); resolve(); }
    function error(err) { cleanup(); reject(err); }
    function aborted() { error(new Error('Client disconnected')); }
    req.on('data', data).once('end', end).once('error', error).once('aborted', aborted);
  });
  const raw = Buffer.concat(chunks);
  if (capture) await capture(raw);
  try { return JSON.parse(raw.toString('utf8')); } catch {
    throw new BridgeError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

export function rewriteBody(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BridgeError(400, 'invalid_request', 'JSON object required');
  if (typeof body.model !== 'string' || !body.model.trim()) throw new BridgeError(400, 'invalid_request', 'model is required');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new BridgeError(400, 'invalid_request', 'stream must be boolean');
  if (!Array.isArray(body.tools) || !body.tools.some(tool => tool?.type === 'image_generation')) {
    throw new BridgeError(400, 'image_tool_required', 'This bridge requires a native image_generation tool');
  }
  if (body.background === true) throw new BridgeError(400, 'background_not_supported', 'Background tasks are not supported');
  const upstream = structuredClone(body);
  upstream.model = config.controlModel;
  upstream.stream = false;
  delete upstream.background;
  delete upstream.stream_options;
  for (const tool of upstream.tools) {
    if (tool?.type === 'image_generation') delete tool.partial_images;
  }
  return upstream;
}

function validateResponse(response) {
  if (!response || typeof response !== 'object' || typeof response.id !== 'string' ||
      !Array.isArray(response.output) || !['completed', 'failed', 'incomplete'].includes(response.status)) {
    throw new BridgeError(502, 'invalid_upstream_response', 'Upstream did not return a terminal Responses object');
  }
  for (const item of response.output) {
    if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') {
      throw new BridgeError(502, 'invalid_upstream_response', 'Upstream output item is missing its ID or type');
    }
  }
  if (response.status === 'completed' && (response.error || !response.output.some(
    item => item.type === 'image_generation_call' && item.status === 'completed' && typeof item.result === 'string' && item.result.length > 0,
  ))) {
    throw new BridgeError(502, 'image_missing', 'Upstream completed without a successful image_generation_call result');
  }
  return response;
}

export function createBridge(baseConfig, { upstream = callUpstream, editUpstream = callDirectEdit,
  imageLoader, logger = entry => console.log(JSON.stringify(entry)), state, management } = {}) {
  const queue = new Queue(baseConfig.maxConcurrent ?? Infinity, baseConfig.maxQueue);
  if (state) state.onConfigChanged = () => {
    queue.limit = baseConfig.maxConcurrent ?? Infinity;
    queue.maxQueue = baseConfig.maxQueue;
    queue.drain();
  };
  const controllers = new Set();
  const server = http.createServer(async (req, res) => {
    if (management && await management(req, res)) return;
    const requestPath = new URL(req.url, 'http://bridge.local').pathname;
    if (publicAPIPaths.has(requestPath)) {
      enableAPICORS(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
        res.end();
        return;
      }
    }
    const config = { ...baseConfig };
    const bridgeID = randomUUID();
    const begin = Date.now();
    let streaming = false;
    let heartbeat;
    let timeout;
    let release;
    let finished = false;
    let outcome = 'failed';
    let errorCode;
    let errorDetail;
    let responseModel;
    let upstreamResponseID;
    let upstreamMeta = {};
    let queueMs = 0;
    let imageCount = 0;
    let heartbeatCount = 0;
    let route = 'responses';
    let imageModel;
    let sourceImages;
    let requestedModel;
    let isResponses = false;
    let emit;
    let replayStarted = false;
    let clientKey = '';
    let requestFormat = req.method === 'POST' && ['/v1/responses', '/responses'].includes(requestPath) ?
      describeRequest(req, requestPath) : undefined;
    const controller = new AbortController();
    const { signal } = controller;
    const abortOnClose = () => { if (!finished) controller.abort(new Error('Client disconnected')); };
    res.on('close', abortOnClose);
    res.setHeader('X-Bridge-Request-Id', bridgeID);
    function safeMessage(message) {
      let value = String(message).slice(0, 2000);
      for (const secret of [clientKey]) {
        if (secret) value = value.split(secret).join('[REDACTED]');
      }
      return value;
    }
    try {
      const path = requestPath;
      isResponses = req.method === 'POST' && ['/v1/responses', '/responses'].includes(path);
      if (req.method === 'GET' && path === '/healthz') {
        outcome = 'health';
        sendJSON(res, 200, { status: 'ok', active: queue.active, queued: queue.waiting.length });
        return;
      }
      clientKey = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1] || '';
      if (!clientKey) {
        throw new BridgeError(401, 'invalid_api_key', 'A valid Bearer API key is required');
      }
      if (req.method === 'GET' && ['/v1/models', '/models'].includes(path)) {
        outcome = 'models';
        sendJSON(res, 200, {
          object: 'list',
          data: [...new Set(['gpt-5.5', config.controlModel, 'gpt-image-2'])].map(id => ({
            id, object: 'model', created: 0, owned_by: 'responses-image-bridge',
          })),
        });
        return;
      }
      if (req.method !== 'POST' || !['/v1/responses', '/responses'].includes(path)) {
        throw new BridgeError(404, 'not_found', 'Use POST /v1/responses with an image_generation tool');
      }
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
        throw new BridgeError(415, 'unsupported_encoding', 'Compressed request bodies are not supported');
      }
      const body = await readJSON(req, config.maxBodyBytes, config.rawRequestLogging && state ? async raw => {
        await state.captureRawRequest(bridgeID, {
          captured_at: Date.now(), method: req.method, url: req.url,
          http_version: req.httpVersion, raw_headers: req.rawHeaders,
          body: raw.toString('utf8'), body_bytes: raw.length,
        });
      } : undefined);
      requestFormat = describeRequest(req, requestPath, body);
      requestedModel = typeof body?.model === 'string' ? body.model.slice(0, 100) : undefined;
      route = config.directEdits && imageInputPresent(body) ? 'images-edits' : 'responses';
      if (route === 'images-edits') {
        const toolModel = body.tools?.find(tool => tool?.type === 'image_generation')?.model;
        imageModel = typeof toolModel === 'string' ? toolModel.slice(0, 100) : undefined;
        sourceImages = body.input.reduce((count, item) => count + (Array.isArray(item?.content) ?
          item.content.filter(part => part?.type === 'input_image').length : Number(item?.type === 'input_image')), 0);
      }
      const rewritten = rewriteBody(body, config);
      let edit = route === 'images-edits' ? parseDirectEdit(body) : null;
      imageModel = edit?.model;
      sourceImages = edit?.images.length;
      if (state?.paused) throw new BridgeError(503, 'bridge_paused', 'Bridge is paused; retry later');
      if (queue.full) throw new BridgeError(429, 'queue_full', 'Bridge queue is full; retry later');
      controllers.add(controller);
      timeout = setTimeout(() => {
        controller.abort(new BridgeError(504, 'bridge_timeout', 'Bridge request deadline exceeded'));
      }, config.timeoutMs);
      streaming = body.stream === true;
      state?.track(bridgeID, {
        started_at: begin, outcome: 'queued', phase: 'queued', stream: streaming,
        requested_model: requestedModel, control_model: config.controlModel, route,
        image_model: imageModel, source_images: sourceImages, request_format: requestFormat,
      }, () => controller.abort(new BridgeError(499, 'operator_cancelled', 'Request canceled by administrator')));
      if (streaming) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        emit = eventWriter(res, signal);
        await writeFrame(res, ': bridge connected; waiting for synchronous upstream\n\n', signal);
        heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableNeedDrain) {
            res.write(': keep-alive\n\n');
            heartbeatCount++;
            state?.track(bridgeID, { heartbeat_count: heartbeatCount });
          }
        }, config.heartbeatMs);
      }
      release = await queue.acquire(signal);
      signal.throwIfAborted();
      queueMs = Date.now() - begin;
      state?.track(bridgeID, { outcome: 'running', phase: edit?.remoteCount ? 'source_download' : 'upstream', queue_ms: queueMs });
      if (edit?.remoteCount) {
        edit = await materializeDirectEdit(edit, signal, imageLoader);
        state?.track(bridgeID, { phase: 'upstream' });
      }
      // Forward only explicitly allowed non-secret context headers.
      const forwardHeaders = {};
      for (const name of ['session-id', 'session_id', 'conversation_id', 'x-session-id']) {
        if (typeof req.headers[name] === 'string') forwardHeaders[name] = req.headers[name];
      }
      const observe = meta => {
        upstreamMeta = meta;
        state?.track(bridgeID, { ...meta, phase: 'upstream_headers' });
      };
      const response = validateResponse(edit ?
        wrapDirectEdit(await editUpstream(config, edit, clientKey, forwardHeaders, signal, observe), edit, body.model) :
        await upstream(config, rewritten, clientKey, forwardHeaders, signal, observe));
      if (response.error) response.error = { ...response.error, message: safeMessage(response.error.message || 'Upstream failed') };
      signal.throwIfAborted();
      responseModel = response.model;
      upstreamResponseID = response.id;
      errorCode = response.error?.code;
      imageCount = response.output.filter(item => item.type === 'image_generation_call' && item.result).length;
      clearInterval(heartbeat);
      state?.track(bridgeID, { phase: 'delivery' });
      if (streaming) {
        replayStarted = true;
        await emitResponse(emit, response);
        if (config.doneSentinel) await writeFrame(res, 'data: [DONE]\n\n', signal);
        res.end();
      } else sendJSON(res, 200, response);
      outcome = response.status;
      finished = true;
    } catch (err) {
      clearInterval(heartbeat);
      const reason = signal.aborted ? signal.reason : err;
      errorCode = reason instanceof BridgeError ? reason.code : 'upstream_connection_error';
      if (reason instanceof BridgeError && ['direct_edit_unsupported', 'image_download_failed',
        'image_download_timeout', 'image_url_blocked', 'image_too_large', 'image_missing', 'upstream_http_error',
        'bridge_timeout', 'request_too_large'].includes(reason.code)) {
        errorDetail = reason.message.slice(0, 240);
      }
      if (errorCode === 'operator_cancelled') outcome = 'canceled';
      const status = reason instanceof BridgeError ? reason.status : 502;
      const error = {
        type: status < 500 ? 'invalid_request_error' : 'server_error',
        code: errorCode,
        message: reason instanceof BridgeError ? safeMessage(reason.message) : 'Upstream connection failed or was interrupted',
      };
      if (!res.destroyed) {
        if (streaming && res.headersSent) {
          if (replayStarted) {
            // Never introduce a second response ID after snapshot replay began.
            res.destroy();
            return;
          }
          // The request deadline has aborted the upstream; allow a short,
          // separately bounded window to deliver the terminal failure.
          try {
            const failureSignal = AbortSignal.timeout(2000);
            const failure = {
              id: `resp_bridge_${bridgeID.replaceAll('-', '')}`,
              object: 'response', created_at: Math.floor(begin / 1000),
              status: 'failed', model: config.controlModel, output: [], error, usage: null,
            };
            await emitResponse(eventWriter(res, failureSignal), failure);
            if (config.doneSentinel) await writeFrame(res, 'data: [DONE]\n\n', failureSignal);
            res.end();
          } catch { res.destroy(); }
        } else sendJSON(res, status, { error });
      } else outcome = 'client_disconnected';
      finished = true;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      release?.();
      controllers.delete(controller);
      res.off('close', abortOnClose);
      if (!req.complete) req.resume();
      const entry = {
        request_id: bridgeID, outcome, error_code: errorCode, error_detail: errorDetail, phase: 'finished',
        stream: streaming, control_model: config.controlModel, response_model: responseModel,
        requested_model: requestedModel, route, image_model: imageModel, source_images: sourceImages,
        upstream_endpoint: route === 'images-edits' ? '/v1/images/edits' : '/v1/responses',
        upstream_host: new URL(config.upstreamURL).host, heartbeat_count: heartbeatCount,
        upstream_response_id: upstreamResponseID, ...upstreamMeta,
        images: imageCount, queue_ms: queueMs, started_at: begin, elapsed_ms: Date.now() - begin,
        request_format: requestFormat,
      };
      if (!['health', 'models'].includes(outcome)) logger(entry);
      if (state && isResponses) state.finish(entry);
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  server.timeout = 0;
  server.queue = queue;
  server.abortPending = () => {
    for (const controller of controllers) controller.abort(new BridgeError(503, 'shutting_down', 'Bridge is shutting down'));
  };
  management?.attach(server);
  return server;
}
