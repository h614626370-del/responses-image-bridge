import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { State } from '../src/state.js';
import { createBridge } from '../src/server.js';
import { createManagement } from '../src/management.js';
import { querySub2api } from '../src/sub2api.js';

const body = { model: 'gpt-5.5', stream: true, input: 'private-prompt',
  tools: [{ type: 'image_generation', model: 'gpt-image-2' }] };
const result = { id: 'resp_test', model: 'gpt-5.6-luna', object: 'response',
  status: 'completed', output: [{ id: 'ig_test', type: 'image_generation_call',
    status: 'completed', result: 'private-image-data' }] };
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
async function fixture(t, upstream = async () => structuredClone(result)) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
  const config = loadConfig({ HEARTBEAT_MS: '20', REQUEST_TIMEOUT_MS: '3000' });
  const state = await State.open(config, directory);
  const bridge = createBridge(config, { state, management: createManagement(state), upstream, logger() {} });
  const url = await listen(bridge);
  t.after(async () => {
    await close(bridge);
    await state.updated;
    await rm(directory, { recursive: true, force: true });
  });
  let cookie = '';
  const api = (route, method = 'GET', data, headers = {}) => fetch(`${url}/admin/api${route}`, {
    method, headers: { 'X-Bridge-Admin': '1', 'Content-Type': 'application/json', Cookie: cookie, ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  async function login() {
    const response = await api('/login', 'POST', { key: state.loginKey });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  }
  const post = () => fetch(`${url}/v1/responses`, { method: 'POST',
    headers: { Authorization: 'Bearer private-client-key', 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
  return { api, login, state, bridge, config, url, directory, post };
}

test('management requires independent session, custom header and same-origin requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/status')).status, 401);
  assert.equal((await f.api('/login', 'POST', { key: 'wrong' })).status, 401);
  assert.equal((await f.api('/login', 'POST', { key: f.state.loginKey }, { Origin: 'https://evil.invalid' })).status, 403);
  await f.login();
  assert.equal((await f.api('/status', 'GET', undefined, { 'X-Bridge-Admin': '' })).status, 403);
  assert.equal((await f.api('/status', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.api('/status')).status, 200);
  const page = await fetch(`${f.url}/admin/`);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /settings-form/);
  assert.equal((await f.api('/logout', 'POST', {})).status, 200);
  assert.equal((await f.api('/status')).status, 401);
});

test('management login is rate limited and malformed/oversize bodies return useful errors', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/login', 'POST', null)).status, 400);
  assert.equal((await f.api('/login', 'POST', { key: 'x'.repeat(20000) })).status, 413);
  for (let i = 0; i < 10; i++) assert.equal((await f.api('/login', 'POST', { key: 'wrong' })).status, 401);
  assert.equal((await f.api('/login', 'POST', { key: f.state.loginKey })).status, 429);
});

test('settings encrypt credentials, never return them, survive reopen and validate atomically', async t => {
  const f = await fixture(t);
  await f.login();
  const secrets = { sub2apiKey: 'private-admin-key' };
  const response = await f.api('/settings', 'PUT', { ...secrets, controlModel: 'gpt-5.5',
    maxConcurrent: 7, directEdits: false, rawRequestLogging: true });
  assert.equal(response.status, 200);
  const publicData = await response.text();
  const disk = await readFile(path.join(f.directory, 'settings.json'), 'utf8');
  for (const value of Object.values(secrets)) {
    assert.ok(!disk.includes(value));
    assert.ok(!publicData.includes(value));
  }
  assert.equal(JSON.parse(publicData).sub2apiKeyConfigured, true);
  assert.equal(f.bridge.queue.limit, 7);
  const restored = await State.open(loadConfig({}), f.directory);
  assert.equal(restored.config.sub2apiKey, secrets.sub2apiKey);
  assert.equal(restored.config.controlModel, 'gpt-5.5');
  assert.equal(restored.config.directEdits, false);
  assert.equal(restored.config.rawRequestLogging, true);
  for (const patch of [{ maxConcurrent: 0 }, { bridgeKey: '' }, { proxy: 'http://127.0.0.1:7897' },
    { doneSentinel: 'false' }, { directEdits: 'true' }, { rawRequestLogging: 'true' },
    { sub2apiKey: 'bad\nheader' }, { sub2apiBase: 'https://user:pass@host' }, { arbitrary: true }]) {
    assert.equal((await f.api('/settings', 'PUT', patch)).status, 400);
  }
  assert.equal(f.config.maxConcurrent, 7);
  assert.equal(await readFile(path.join(f.directory, 'settings.json'), 'utf8'), disk);
  assert.equal((await f.api('/settings', 'PUT', { maxConcurrent: null })).status, 200);
  assert.equal(f.config.maxConcurrent, null);
  assert.equal(f.bridge.queue.limit, Infinity);
  const unlimited = await State.open(loadConfig({}), f.directory);
  assert.equal(unlimited.config.maxConcurrent, null);
});

test('pause prevents work, cancel ends SSE and persisted metadata excludes prompt/image/keys', async t => {
  let started = 0;
  const f = await fixture(t, async (_config, _body, _key, _headers, signal) => {
    started++;
    await delay(2000, undefined, { signal });
    return structuredClone(result);
  });
  await f.login();
  await f.api('/pause', 'POST', { paused: true });
  assert.equal((await f.post()).status, 503);
  assert.equal(started, 0);
  await f.api('/pause', 'POST', { paused: false });
  const response = await f.post();
  const id = response.headers.get('x-bridge-request-id');
  assert.equal((await f.api(`/requests/${id}/cancel`, 'POST', {})).status, 200);
  assert.match(await response.text(), /operator_cancelled/);
  await f.state.updated;
  const rows = (await (await f.api('/requests')).json()).items;
  assert.equal(rows[0].outcome, 'canceled');
  assert.equal((await f.api(`/requests/${id}/cancel`, 'POST', {})).status, 404);
  const disk = await readFile(path.join(f.directory, 'requests.json'), 'utf8');
  assert.doesNotMatch(disk, /private-prompt|private-image-data|private-client-key/);
  assert.match(disk, /request_format/);
  assert.match(disk, /redacted text chars=14/);
  assert.match(disk, /image_generation/);
  assert.equal((await (await f.api('/export')).json()).length, 2);
});

test('validation failures retain a bounded sanitized request format', async t => {
  const f = await fixture(t);
  await f.login();
  const response = await fetch(`${f.url}/v1/responses`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer private-client-key',
      'Content-Type': 'application/json',
      'X-Client-Version': 'private-client-version',
    },
    body: JSON.stringify({
      model: 'gpt-5.5', stream: true, input: 'private failed prompt',
      extension: { token: 'private-body-token', mode: 'private-mode' },
    }),
  });
  assert.equal(response.status, 400);
  const id = response.headers.get('x-bridge-request-id');
  await f.state.updated;
  const data = await (await f.api(`/requests?search=${id}`)).json();
  assert.equal(data.total, 1);
  assert.equal(data.items[0].error_code, 'image_tool_required');
  assert.equal(data.items[0].request_format.body.model, 'gpt-5.5');
  assert.equal(data.items[0].request_format.body.input, '[redacted text chars=21]');
  assert.equal(data.items[0].request_format.body.extension.token, '[redacted secret]');
  const text = JSON.stringify(data.items[0].request_format);
  assert.match(text, /authorization/);
  assert.doesNotMatch(text, /private-client-key|private-client-version|private failed prompt|private-body-token|private-mode/);
});

test('opt-in raw request logging stores the exact received headers and JSON body', async t => {
  const f = await fixture(t);
  f.config.rawRequestLogging = true;
  await f.login();
  const rawBody = '{ "model": "gpt-5.5", "input": "private raw prompt" }';
  const response = await fetch(`${f.url}/v1/responses`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer private-raw-key',
      'Content-Type': 'application/json',
      'X-Private-Client': 'private-header-value',
    },
    body: rawBody,
  });
  assert.equal(response.status, 400);
  const id = response.headers.get('x-bridge-request-id');
  await f.state.updated;
  const rawResponse = await f.api(`/requests/${id}/raw`);
  assert.equal(rawResponse.status, 200);
  const raw = await rawResponse.json();
  assert.equal(raw.body, rawBody);
  assert.equal(raw.body_bytes, Buffer.byteLength(rawBody));
  assert.ok(raw.raw_headers.includes('Bearer private-raw-key'));
  assert.ok(raw.raw_headers.includes('private-header-value'));
  assert.equal((await f.api(`/requests/${id}`, 'DELETE')).status, 200);
  assert.equal((await f.api(`/requests/${id}/raw`)).status, 404);
});

test('completed request logs can be deleted individually or cleared while live requests are protected', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async () => {
    await gate;
    return structuredClone(result);
  });
  t.after(() => release());
  await f.login();

  const invalid = await fetch(`${f.url}/v1/responses`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.5' }),
  });
  assert.equal(invalid.status, 400);
  const invalidID = invalid.headers.get('x-bridge-request-id');
  await f.state.updated;
  assert.equal((await f.api(`/requests/${invalidID}`, 'DELETE')).status, 200);
  assert.equal((await f.api(`/requests/${invalidID}`, 'DELETE')).status, 404);

  const live = await f.post();
  const liveID = live.headers.get('x-bridge-request-id');
  assert.equal((await f.api(`/requests/${liveID}`, 'DELETE')).status, 409);
  release();
  await live.text();
  await f.state.updated;

  const secondInvalid = await fetch(`${f.url}/v1/responses`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.5' }),
  });
  assert.equal(secondInvalid.status, 400);
  await f.state.updated;
  const cleared = await f.api('/requests', 'DELETE');
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).deleted, 2);
  assert.equal((await (await f.api('/requests')).json()).total, 0);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'requests.json'), 'utf8')).length, 0);
});

test('runtime model changes affect only new requests and history supports ID search', async t => {
  const seen = [];
  let complete;
  const gate = new Promise(resolve => { complete = resolve; });
  const f = await fixture(t, async (config, _body, _key, _headers, _signal, observe) => {
    seen.push(config.controlModel);
    await gate;
    observe({ upstream_request_id: 'upstream-test-id', upstream_http_status: 200 });
    return structuredClone(result);
  });
  t.after(() => complete());
  await f.login();
  const first = await f.post();
  while (!seen.length) await delay(5);
  await f.api('/settings', 'PUT', { controlModel: 'gpt-5.5' });
  const second = await f.post();
  complete();
  await Promise.all([first.text(), second.text()]);
  assert.deepEqual(seen, ['gpt-5.6-luna', 'gpt-5.5']);
  const data = await (await f.api('/requests?search=upstream-test-id')).json();
  assert.equal(data.total, 2);
  assert.equal((await (await f.api('/status')).json()).completed, 2);
});

test('sub2api diagnostic calls are GET-only, use x-api-key and strip sensitive fields', async t => {
  const calls = [];
  const upstream = http.createServer((req, res) => {
    calls.push({ url: req.url, method: req.method, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    const item = { id: 3, name: 'test-account', request_id: 'request-test', account_id: 3,
      status: 'active', credentials: { refresh_token: 'secret-refresh' }, extra: 'private-extra' };
    res.end(JSON.stringify({ code: 0, data: req.url.includes('/groups/') ? [item] : { items: [item], total: 1 } }));
  });
  const base = await listen(upstream);
  t.after(() => close(upstream));
  const config = { sub2apiBase: base, sub2apiKey: 'test-admin-secret' };
  for (const kind of ['accounts', 'groups', 'usage']) {
    const data = await querySub2api(config, kind, { request_id: 'request-test', group: '4' });
    assert.equal(data.items.length, 1);
    assert.doesNotMatch(JSON.stringify(data), /secret-refresh|private-extra|credentials/);
  }
  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.headers['x-api-key'], 'test-admin-secret');
    assert.equal(call.headers.authorization, undefined);
  }
  assert.match(calls[0].url, /group=4/);
  assert.match(calls[2].url, /request_id=request-test/);
  await assert.rejects(querySub2api({ ...config, sub2apiKey: '' }, 'accounts'), /Key/);
  await assert.rejects(querySub2api(config, 'delete'), /Unsupported/);
  await assert.rejects(querySub2api(config, 'usage'), /request ID/);
  assert.equal(calls.length, 3);
});

test('obsolete saved generation credentials are removed without changing admin credentials', async t => {
  const f = await fixture(t);
  await f.state.saveSettings({ sub2apiKey: 'admin-stays-private' });
  const file = path.join(f.directory, 'settings.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.upstreamKey = f.state.encrypt('obsolete-upstream');
  saved.bridgeKey = f.state.encrypt('obsolete-bridge');
  saved.proxy = 'http://127.0.0.1:7897';
  await writeFile(file, JSON.stringify(saved));
  const restored = await State.open(loadConfig({}), f.directory);
  assert.equal(restored.config.sub2apiKey, 'admin-stays-private');
  assert.equal(restored.config.upstreamKey, undefined);
  const migrated = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(Object.hasOwn(migrated, 'upstreamKey'), false);
  assert.equal(Object.hasOwn(migrated, 'bridgeKey'), false);
  assert.equal(Object.hasOwn(migrated, 'proxy'), false);
  assert.equal(Object.hasOwn(restored.publicSettings(), 'proxy'), false);
});
