import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { createBridge } from '../src/server.js';

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const requestBody = {
  model: 'gpt-5.5', stream: true, input: 'Generate one image',
  stream_options: { include_usage: true },
  tools: [{ type: 'image_generation', model: 'gpt-image-2', partial_images: 2, quality: 'high' }],
};
function snapshot(overrides = {}) {
  return {
    id: 'resp_test', object: 'response', model: 'gpt-5.6-luna',
    created_at: 123, status: 'completed', error: null,
    output: [
      { id: 'rs_test', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Generate a landscape.' }] },
      { id: 'ig_test', type: 'image_generation_call', status: 'completed', result: image },
      { id: 'msg_test', type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: 'Done.', annotations: [] }] },
    ],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    ...overrides,
  };
}
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.abortPending?.();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function fixture(t, handle = async (_body, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(snapshot()));
}, overrides = {}) {
  const captured = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    captured.push({ body, headers: req.headers });
    try { await handle(body, res, req); } catch { res.destroy(); }
  });
  const url = await listen(upstream);
  const config = loadConfig({
    UPSTREAM_BASE_URL: url, HEARTBEAT_MS: '20',
    MAX_CONCURRENT: '4', REQUEST_TIMEOUT_MS: '3000', ...overrides,
  });
  const logs = [];
  const bridge = createBridge(config, { logger: entry => logs.push(entry) });
  const bridgeURL = await listen(bridge);
  t.after(async () => { await close(bridge); await close(upstream); });
  function post(body = requestBody, options = {}) {
    return fetch(`${bridgeURL}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-client-secret', 'Content-Type': 'application/json',
        'session-id': 'unique-session', ...options.headers },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }
  return { post, captured, bridge, bridgeURL, logs };
}
function events(text) {
  return text.split(/\r?\n\r?\n/).flatMap(frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    return data && data !== '[DONE]' ? [JSON.parse(data)] : [];
  });
}
test('configuration normalizes base URLs and ignores obsolete fixed credentials', () => {
  assert.equal(loadConfig({}).maxConcurrent, null);
  assert.equal(loadConfig({ MAX_CONCURRENT: '' }).maxConcurrent, null);
  for (const base of ['https://example.org', 'https://example.org/v1/', 'https://example.org/v1/responses']) {
    assert.equal(loadConfig({ UPSTREAM_BASE_URL: base }).upstreamURL, 'https://example.org/v1/responses');
  }
  assert.equal(loadConfig({ UPSTREAM_API_KEY: 'secret' }).upstreamKey, undefined);
  assert.equal(loadConfig({}).rawRequestLogging, false);
  assert.equal(loadConfig({ RAW_REQUEST_LOGGING: 'true' }).rawRequestLogging, true);
  assert.throws(() => loadConfig({ RAW_REQUEST_LOGGING: 'yes' }), /RAW_REQUEST_LOGGING/);
  assert.equal(loadConfig({ HOST: '0.0.0.0' }).host, '0.0.0.0');
  assert.throws(() => loadConfig({ MAX_CONCURRENT: '0' }), /MAX_CONCURRENT/);
  assert.equal(loadConfig({ UPSTREAM_PROXY: 'http://localhost:7897' }).proxy, undefined);
});

test('browser clients can preflight model APIs without exposing management APIs', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.bridgeURL}/v1/responses`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://desktop-client.local',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,x-client-version',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(response.headers.get('access-control-allow-headers'),
    'authorization,content-type,x-client-version');
  assert.match(response.headers.get('access-control-expose-headers'), /X-Bridge-Request-Id/i);
  assert.equal(f.captured.length, 0);

  const post = await f.post(requestBody, { headers: { Origin: 'http://desktop-client.local' } });
  assert.equal(post.headers.get('access-control-allow-origin'), '*');
  await post.text();

  const management = await fetch(`${f.bridgeURL}/admin/api/status`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://desktop-client.local' },
  });
  assert.equal(management.headers.get('access-control-allow-origin'), null);
});
test('rewrites only driver and transport; emits early heartbeats and consistent image events', async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, async (_body, res) => {
    await gate;
    res.end(JSON.stringify(snapshot()));
  });
  t.after(() => finish());
  const response = await f.post();
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /: bridge connected/);
  const heartbeat = new TextDecoder().decode((await reader.read()).value);
  assert.match(heartbeat, /keep-alive/);
  assert.doesNotMatch(first + heartbeat, /response\.completed|generating/);
  finish();
  let text = first + heartbeat;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  const list = events(text);
  assert.equal(f.captured.length, 1);
  assert.equal(f.captured[0].body.model, 'gpt-5.6-luna');
  assert.equal(f.captured[0].body.stream, false);
  assert.equal(f.captured[0].body.background, undefined);
  assert.equal(f.captured[0].body.tools[0].model, 'gpt-image-2');
  assert.equal(f.captured[0].body.tools[0].quality, 'high');
  assert.equal(f.captured[0].body.tools[0].partial_images, undefined);
  assert.equal(f.captured[0].body.stream_options, undefined);
  assert.equal(f.captured[0].headers.authorization, 'Bearer test-client-secret');
  assert.equal(f.captured[0].headers['session-id'], 'unique-session');
  assert.deepEqual(list.map(e => e.sequence_number), list.map((_, i) => i));
  assert.equal(list[0].type, 'response.created');
  assert.equal(list.at(-1).type, 'response.completed');
  assert.equal(list.at(-1).response.id, list[0].response.id);
  assert.deepEqual(list.at(-1).response.usage, snapshot().usage);
  const imageDone = list.filter(e => e.type === 'response.output_item.done' && e.item.type === 'image_generation_call');
  assert.equal(imageDone.length, 1);
  assert.equal(imageDone[0].item.id, list.at(-1).response.output[1].id);
  assert.equal(imageDone[0].item.result, image);
  assert.equal(list.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join(''), 'Done.');
  assert.doesNotMatch(JSON.stringify(f.logs), /test-client-secret|Generate one image|iVBOR/);
});
test('30 simultaneous clients queue at bounded upstream concurrency with one call each', async t => {
  let active = 0;
  let peak = 0;
  const f = await fixture(t, async (_body, res) => {
    active++;
    peak = Math.max(peak, active);
    await delay(20);
    active--;
    res.end(JSON.stringify(snapshot()));
  }, { MAX_CONCURRENT: '3', MAX_QUEUE: '30' });
  const texts = await Promise.all(Array.from({ length: 30 }, async () => (await f.post()).text()));
  assert.equal(peak, 3);
  assert.equal(f.captured.length, 30);
  assert.equal(texts.filter(text => events(text).at(-1)?.type === 'response.completed').length, 30);
  assert.equal(f.bridge.queue.active, 0);
  assert.equal(f.bridge.queue.waiting.length, 0);
});
test('upstream 503 becomes failed SSE, redacts credentials, and is never retried', async t => {
  const f = await fixture(t, async (_body, res) => {
    res.writeHead(503);
    res.end(JSON.stringify({ error: { code: 'server_error', message: 'overloaded test-client-secret' } }));
  });
  const response = await f.post();
  assert.equal(response.status, 200);
  const text = await response.text();
  const list = events(text);
  assert.equal(list[0].type, 'response.created');
  assert.equal(list.at(-1).type, 'response.failed');
  assert.equal(list.at(-1).response.error.code, 'server_error');
  assert.doesNotMatch(text, /test-client-secret/);
  assert.equal(f.captured.length, 1);
});
test('upstream non-JSON HTTP 504 is reported as an upstream HTTP error', async t => {
  const f = await fixture(t, async (_body, res) => {
    res.writeHead(504, { 'Content-Type': 'text/html' });
    res.end('<html>gateway timeout private-client-key</html>');
  });
  const list = events(await (await f.post()).text());
  assert.equal(list.at(-1).response.error.code, 'upstream_http_error');
  assert.match(list.at(-1).response.error.message, /HTTP 504/);
  assert.doesNotMatch(JSON.stringify(list), /private-client-key|<html>/);
  assert.equal(f.captured.length, 1);
});
test('non-stream client receives ordinary rewritten JSON', async t => {
  const f = await fixture(t);
  const response = await f.post({ ...requestBody, stream: false });
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal((await response.json()).output[1].result, image);
});
test('terminal failed and incomplete upstream responses are preserved', async t => {
  for (const status of ['failed', 'incomplete']) {
    const f = await fixture(t, async (_body, res) => res.end(JSON.stringify(snapshot({
      status, output: [], error: status === 'failed' ? { code: 'server_error', message: 'overloaded' } : null,
      incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    }))));
    const list = events(await (await f.post()).text());
    assert.equal(list.at(-1).type, `response.${status}`);
    assert.equal(list.at(-1).response.id, 'resp_test');
  }
});
test('missing image or unexpected SSE upstream is an explicit failure, not success', async t => {
  for (const payload of [JSON.stringify(snapshot({ output: [] })), 'data: {"type":"response.created"}\n\n']) {
    const f = await fixture(t, async (_body, res) => res.end(payload));
    const list = events(await (await f.post()).text());
    assert.equal(list.at(-1).type, 'response.failed');
  }
});
test('authentication and validation fail before spending upstream requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(requestBody, { headers: { Authorization: '' } })).status, 401);
  assert.equal((await f.post({ ...requestBody, tools: [] })).status, 400);
  assert.equal((await f.post({ ...requestBody, stream: 'true' })).status, 400);
  assert.equal((await f.post({ ...requestBody, background: true })).status, 400);
  assert.equal((await fetch(`${f.bridgeURL}/v1/images/generations`, { headers: { Authorization: 'Bearer x' } })).status, 404);
  assert.equal(f.captured.length, 0);
});
test('different clients retain their own keys even with obsolete fixed-key environment values', async t => {
  const f = await fixture(t, undefined, { UPSTREAM_API_KEY: 'upstream-secret', BRIDGE_API_KEY: 'bridge-secret' });
  await Promise.all(['client-one', 'client-two'].map(async key => {
    await (await f.post(requestBody, { headers: { Authorization: `Bearer ${key}` } })).text();
  }));
  assert.deepEqual(f.captured.map(item => item.headers.authorization).sort(),
    ['Bearer client-one', 'Bearer client-two']);
});
test('queue overflow rejects immediately; timed-out requests release capacity', async t => {
  const f = await fixture(t, async () => {}, { MAX_CONCURRENT: '1', MAX_QUEUE: '0', REQUEST_TIMEOUT_MS: '150' });
  const first = await f.post();
  const second = await f.post();
  assert.equal(second.status, 429);
  const list = events(await first.text());
  assert.equal(list.at(-1).response.error.code, 'bridge_timeout');
  assert.equal(f.bridge.queue.active, 0);
  assert.equal(f.captured.length, 1);
});
test('client disconnect cancels upstream and releases the slot', async t => {
  let upstreamClosed = false;
  const f = await fixture(t, async (_body, res) => { res.on('close', () => { upstreamClosed = true; }); });
  const controller = new AbortController();
  const response = await f.post(requestBody, { signal: controller.signal });
  await response.body.getReader().read();
  for (let i = 0; i < 50 && f.captured.length === 0; i++) await delay(10);
  controller.abort();
  for (let i = 0; i < 50 && !upstreamClosed; i++) await delay(10);
  assert.equal(upstreamClosed, true);
  assert.equal(f.bridge.queue.active, 0);
});
test('oversize request and upstream response are bounded', async t => {
  const f = await fixture(t, undefined, { MAX_BODY_BYTES: '256' });
  assert.equal((await f.post({ ...requestBody, input: 'x'.repeat(1000) })).status, 413);
  const g = await fixture(t, undefined, { MAX_RESPONSE_BYTES: '128' });
  const list = events(await (await g.post()).text());
  assert.equal(list.at(-1).response.error.code, 'upstream_response_too_large');
});
test('model list and health work; optional DONE sentinel follows completed', async t => {
  const f = await fixture(t, undefined, { SSE_DONE_SENTINEL: 'true' });
  assert.equal((await fetch(`${f.bridgeURL}/healthz`)).status, 200);
  const models = await (await fetch(`${f.bridgeURL}/v1/models`, { headers: { Authorization: 'Bearer x' } })).json();
  assert.ok(models.data.some(model => model.id === 'gpt-5.6-luna'));
  const text = await (await f.post()).text();
  assert.ok(text.endsWith('data: [DONE]\n\n'));
});

test('queued client cancellation removes its pending request without upstream work', async t => {
  const f = await fixture(t, async () => {}, { MAX_CONCURRENT: '1', REQUEST_TIMEOUT_MS: '250' });
  const first = await f.post();
  const controller = new AbortController();
  const second = await f.post(requestBody, { signal: controller.signal });
  await second.body.getReader().read();
  assert.equal(f.bridge.queue.waiting.length, 1);
  controller.abort();
  for (let i = 0; i < 50 && f.bridge.queue.waiting.length; i++) await delay(5);
  assert.equal(f.bridge.queue.waiting.length, 0);
  await first.text();
  assert.equal(f.captured.length, 1);
});

test('obsolete proxy environment does not prevent direct upstream requests', async t => {
  const f = await fixture(t, undefined, { UPSTREAM_PROXY: 'http://127.0.0.1:1' });
  const list = events(await (await f.post()).text());
  assert.equal(list.at(-1).type, 'response.completed');
  assert.equal(f.captured.length, 1);
});
