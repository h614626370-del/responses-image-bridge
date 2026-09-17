import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { State, logWindowMs } from '../src/state.js';
import { createBridge } from '../src/server.js';
import { downloadRemoteImage } from '../src/direct-edits.js';

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const dataURL = `data:image/png;base64,${image}`;
const editBody = {
  model: 'gpt-5.5', stream: true, instructions: 'Keep the foreground.',
  input: [{ role: 'user', content: [
    { type: 'input_text', text: 'Change the sky to blue.' },
    { type: 'input_image', image_url: dataURL },
  ] }],
  tools: [{ type: 'image_generation', model: 'gpt-image-2', action: 'edit', quality: 'high' }],
};
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
function events(raw) {
  return raw.split(/\r?\n\r?\n/).flatMap(frame => {
    const data = frame.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5).trim();
    return data && data !== '[DONE]' ? [JSON.parse(data)] : [];
  });
}
async function fixture(t, upstreamHandler, overrides = {}, bridgeOverrides = {}) {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    requests.push({ path: req.url, headers: req.headers, raw });
    await upstreamHandler(req, res, raw);
  });
  const upstreamURL = await listen(upstream);
  const directory = await mkdtemp(path.join(tmpdir(), 'edit-bridge-test-'));
  const config = loadConfig({ UPSTREAM_BASE_URL: upstreamURL, HEARTBEAT_MS: '20',
    REQUEST_TIMEOUT_MS: '3000', ...overrides });
  const state = await State.open(config, directory);
  const bridge = createBridge(config, { state, logger() {}, ...bridgeOverrides });
  const url = await listen(bridge);
  t.after(async () => {
    await close(bridge);
    await close(upstream);
    await state.updated;
    await rm(directory, { recursive: true, force: true });
  });
  const post = (body = editBody) => fetch(`${url}/v1/responses`, { method: 'POST',
    headers: { Authorization: 'Bearer private-client-key', 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
  return { requests, post, state, directory };
}

test('image-to-image converts base64 input into one multipart edit and replays Responses SSE', async t => {
  const f = await fixture(t, async (_req, res) => {
    await delay(55);
    res.setHeader('x-request-id', 'edit-upstream-123');
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: image }],
      output_format: 'png', usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } }));
  });
  const response = await f.post();
  const raw = await response.text();
  const list = events(raw);
  assert.equal(response.status, 200);
  assert.match(raw, /keep-alive/);
  assert.equal(list[0].type, 'response.created');
  assert.equal(list.at(-1).type, 'response.completed');
  assert.equal(list.at(-1).response.model, 'gpt-5.5');
  assert.equal(list.at(-1).response.output[0].result, image);
  assert.equal(list.at(-1).response.output[0].id, list.find(e => e.type === 'response.output_item.done').item.id);
  assert.deepEqual(list.map(e => e.sequence_number), list.map((_, i) => i));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/v1/images/edits');
  assert.equal(f.requests[0].headers.authorization, 'Bearer private-client-key');
  const multipart = new Request('http://local.test', { method: 'POST', headers: {
    'Content-Type': f.requests[0].headers['content-type'],
  }, body: f.requests[0].raw });
  const form = await multipart.formData();
  assert.equal(form.get('model'), 'gpt-image-2');
  assert.equal(form.get('n'), '1');
  assert.equal(form.get('stream'), null);
  assert.equal(form.get('prompt').replaceAll('\r\n', '\n'),
    'Keep the foreground.\n\nChange the sky to blue.');
  assert.equal(form.get('quality'), 'high');
  assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()), Buffer.from(image, 'base64'));
  await f.state.updated;
  const row = f.state.allRows()[0];
  assert.equal(row.route, 'images-edits');
  assert.equal(row.requested_model, 'gpt-5.5');
  assert.equal(row.image_model, 'gpt-image-2');
  assert.equal(row.source_images, 1);
  assert.equal(row.heartbeat_count > 0, true);
  assert.equal(row.upstream_request_id, 'edit-upstream-123');
  assert.deepEqual(row.timeline.map(step => step.phase),
    ['queued', 'upstream', 'upstream_headers', 'delivery', 'finished']);
  assert.doesNotMatch(await readFile(path.join(f.directory, 'requests.json'), 'utf8'),
    /Change the sky|iVBOR|private-client-key/);
});

test('text-only input uses Responses; disabling direct edits preserves old routing', async t => {
  const f = await fixture(t, async (req, res, raw) => {
    assert.equal(req.url, '/v1/responses');
    assert.equal(JSON.parse(raw).model, 'gpt-5.6-luna');
    res.end(JSON.stringify({ id: 'resp_test', object: 'response', model: 'gpt-5.6-luna',
      status: 'completed', output: [{ id: 'ig_test', type: 'image_generation_call',
        status: 'completed', result: image }] }));
  }, { DIRECT_EDITS: 'false' });
  const result = await (await f.post()).text();
  assert.equal(events(result).at(-1).type, 'response.completed');
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.allRows()[0].route, 'responses');
});

test('text-only input keeps Responses route even while direct edits are enabled', async t => {
  const f = await fixture(t, async (req, res, raw) => {
    assert.equal(req.url, '/v1/responses');
    assert.equal(JSON.parse(raw).model, 'gpt-5.6-luna');
    res.end(JSON.stringify({ id: 'resp_text', object: 'response', model: 'gpt-5.6-luna',
      status: 'completed', output: [{ id: 'ig_text', type: 'image_generation_call',
        status: 'completed', result: image }] }));
  });
  const textOnly = { ...editBody, input: 'Draw a mountain.' };
  assert.equal(events(await (await f.post(textOnly)).text()).at(-1).type, 'response.completed');
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.allRows()[0].route, 'responses');
});

test('non-stream edits upload multiple sources and a mask, then return one JSON response', async t => {
  const f = await fixture(t, async (req, res, raw) => {
    const form = await new Request('http://local.test', { method: 'POST', headers: {
      'Content-Type': req.headers['content-type'],
    }, body: raw }).formData();
    assert.equal(form.getAll('image').length, 2);
    assert.deepEqual(Buffer.from(await form.get('mask').arrayBuffer()), Buffer.from(image, 'base64'));
    assert.equal(form.get('output_format'), 'png');
    res.end(JSON.stringify({ data: [{ b64_json: image }] }));
  });
  const body = structuredClone(editBody);
  body.stream = false;
  body.input[0].content.push({ type: 'input_image', image_url: dataURL });
  body.tools[0].input_image_mask = { image_url: dataURL };
  body.tools[0].output_format = 'png';
  const response = await f.post(body);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const result = await response.json();
  assert.equal(result.status, 'completed');
  assert.equal(result.output[0].result, image);
  assert.equal(f.state.allRows()[0].source_images, 2);
});

test('HTTPS image URLs are downloaded, validated and uploaded as multipart files', async t => {
  const sourceURL = 'https://cdn.example.com/product.png?signature=private';
  const loaded = [];
  const f = await fixture(t, async (req, res, raw) => {
    const form = await new Request('http://local.test', { method: 'POST', headers: {
      'Content-Type': req.headers['content-type'],
    }, body: raw }).formData();
    assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()), Buffer.from(image, 'base64'));
    res.end(JSON.stringify({ data: [{ b64_json: image }] }));
  }, {}, { imageLoader: async (url, signal) => {
    loaded.push({ url, signal });
    return { bytes: Buffer.from(image, 'base64'), mime: 'image/png' };
  } });
  const body = structuredClone(editBody);
  body.input[0].content[1].image_url = sourceURL;
  const result = events(await (await f.post(body)).text());
  assert.equal(result.at(-1).type, 'response.completed');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].url, sourceURL);
  assert.equal(loaded[0].signal.aborted, false);
  assert.deepEqual(f.state.allRows()[0].timeline.map(step => step.phase),
    ['queued', 'source_download', 'upstream', 'upstream_headers', 'delivery', 'finished']);
});

test('remote image downloader rejects loopback and private destinations', async () => {
  for (const url of ['https://127.0.0.1/image.png', 'https://10.0.0.1/image.png', 'http://example.com/image.png']) {
    await assert.rejects(downloadRemoteImage(url), error =>
      ['image_url_blocked', 'direct_edit_unsupported'].includes(error.code));
  }
});

test('invalid or unsupported image inputs fail before spending an upstream request', async t => {
  const f = await fixture(t, async () => { throw new Error('Should not call upstream'); });
  for (const input of [
    { type: 'input_image', file_id: 'file_123' },
    { type: 'input_image', image_url: 'data:image/png;base64,SGVsbG8=' },
  ]) {
    const body = structuredClone(editBody);
    body.input[0].content[1] = input;
    assert.equal((await f.post(body)).status, 400);
  }
  const multiTurn = structuredClone(editBody);
  multiTurn.previous_response_id = 'resp_old';
  assert.equal((await f.post(multiTurn)).status, 400);
  const noPrompt = structuredClone(editBody);
  noPrompt.instructions = '';
  noPrompt.input[0].content.shift();
  assert.equal((await f.post(noPrompt)).status, 400);
  const wrongCount = structuredClone(editBody);
  wrongCount.tools[0].n = 2;
  assert.equal((await f.post(wrongCount)).status, 400);
  assert.equal(f.requests.length, 0);
  assert.equal(f.state.allRows().length, 5);
  assert.ok(f.state.allRows().every(row => row.route === 'images-edits' && row.error_code === 'direct_edit_unsupported'));
  assert.equal(f.state.allRows()[0].image_model, 'gpt-image-2');
  assert.equal(f.state.allRows()[0].source_images, 1);
  assert.match(f.state.allRows().find(row => row.error_detail?.includes('file_id')).error_detail, /file_id/);
});

test('image edit HTTP failures produce one terminal failure and no retry', async t => {
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(504, { 'Content-Type': 'text/html' });
    res.end('<html>timeout private-client-key</html>');
  });
  const list = events(await (await f.post()).text());
  assert.equal(list.at(-1).type, 'response.failed');
  assert.equal(list.at(-1).response.error.code, 'upstream_http_error');
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.allRows()[0].upstream_http_status, 504);
});

test('empty image edits result is a visible failure, never an empty success', async t => {
  const f = await fixture(t, async (_req, res) => res.end(JSON.stringify({ data: [] })));
  const list = events(await (await f.post()).text());
  assert.equal(list.at(-1).type, 'response.failed');
  assert.equal(list.at(-1).response.error.code, 'image_missing');
  assert.equal(f.requests.length, 1);
  assert.match(f.state.allRows()[0].error_detail, /exactly one base64 image/);
});

test('request logs retain all entries from the last 12 hours and prune older rows', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'edit-log-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({});
  const state = await State.open(config, directory);
  const now = Date.now();
  const recent = Array.from({ length: 1001 }, (_, n) => ({ request_id: String(n),
    started_at: now - 1000, outcome: 'completed', elapsed_ms: 50 }));
  await writeFile(path.join(directory, 'requests.json'), JSON.stringify([
    ...recent, { request_id: 'old', started_at: now - logWindowMs - 1000, outcome: 'failed' },
  ]));
  const reopened = await State.open(loadConfig({}), directory);
  assert.equal(reopened.allRows().length, 1001);
  assert.equal(reopened.summary().total, 1001);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'requests.json'), 'utf8')).length, 1001);
  reopened.rows[0].started_at = Date.now() - logWindowMs - 1000;
  reopened.prune();
  await reopened.updated;
  assert.equal(reopened.allRows().length, 1000);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'requests.json'), 'utf8')).length, 1000);
});
