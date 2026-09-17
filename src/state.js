import { mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { loadConfig } from './config.js';

const secretNames = ['sub2apiKey'];
export const logWindowMs = 12 * 60 * 60 * 1000;
const editable = {
  controlModel: 'CONTROL_MODEL', maxConcurrent: 'MAX_CONCURRENT', maxQueue: 'MAX_QUEUE',
  heartbeatMs: 'HEARTBEAT_MS', timeoutMs: 'REQUEST_TIMEOUT_MS',
  upstreamURL: 'UPSTREAM_BASE_URL',
  maxBodyBytes: 'MAX_BODY_BYTES', maxResponseBytes: 'MAX_RESPONSE_BYTES',
};
const requestID = /^[a-f0-9-]{36}$/;
async function atomic(file, content) {
  const temp = `${file}.${randomBytes(5).toString('hex')}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, file);
}
export class State {
  rows = [];
  live = new Map();
  paused = false;
  updated = Promise.resolve();
  persistError = false;
  constructor(config, directory, key) {
    this.config = config;
    this.directory = directory;
    this.key = key;
    this.rawDirectory = path.join(directory, 'raw-requests');
  }
  static async open(config, directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    async function localSecret(file, size) {
      try { return (await readFile(path.join(directory, file), 'utf8')).trim(); } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        const value = randomBytes(size).toString('hex');
        await writeFile(path.join(directory, file), value, { flag: 'wx', mode: 0o600 });
        return value;
      }
    }
    const master = Buffer.from(await localSecret('master.key', 32), 'hex');
    if (master.length !== 32) throw new Error('Invalid local master.key');
    const state = new State(config, directory, master);
    await mkdir(state.rawDirectory, { recursive: true, mode: 0o700 });
    state.loginKey = process.env.MANAGEMENT_KEY || await localSecret('admin-token.txt', 32);
    if (state.loginKey.length < 24) throw new Error('MANAGEMENT_KEY must contain at least 24 characters');
    try {
      const saved = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'));
      // Remove obsolete connection settings without decrypting or using them.
      const legacy = ['upstreamKey', 'bridgeKey', 'proxy'].some(name => Object.hasOwn(saved, name));
      delete saved.upstreamKey;
      delete saved.bridgeKey;
      delete saved.proxy;
      if (legacy) await atomic(path.join(directory, 'settings.json'), JSON.stringify(saved, null, 2));
      for (const name of secretNames) if (saved[name]) saved[name] = state.decrypt(saved[name]);
      Object.assign(config, state.validate(saved));
    } catch (err) { if (err.code !== 'ENOENT') throw new Error('Cannot read local settings: verify data directory and master.key'); }
    try {
      const storedRows = JSON.parse(await readFile(path.join(directory, 'requests.json'), 'utf8'));
      state.rows = storedRows
        .filter(row => row.started_at >= Date.now() - logWindowMs);
      if (state.rows.length !== storedRows.length) {
        await atomic(path.join(directory, 'requests.json'), JSON.stringify(state.rows));
      }
    } catch (err) { if (err.code !== 'ENOENT') throw new Error('Cannot read request history'); }
    await state.pruneRawRequests(new Set(state.rows.map(row => row.request_id)));
    config.sub2apiBase ||= new URL(config.upstreamURL).origin;
    config.sub2apiKey ||= '';
    return state;
  }
  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([
      cipher.update(value, 'utf8'), cipher.final(),
    ]).toString('base64');
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data };
  }
  decrypt(value) {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
  }
  validate(patch) {
    for (const name of secretNames) {
      if (patch[name] !== undefined && (typeof patch[name] !== 'string' ||
          patch[name].length > 4096 || /[\s\x00-\x1f\x7f]/.test(patch[name]))) {
        throw new Error(`${name} must be a key without whitespace, at most 4096 characters`);
      }
    }
    if (patch.doneSentinel !== undefined && typeof patch.doneSentinel !== 'boolean') throw new Error('doneSentinel must be boolean');
    if (patch.rawRequestLogging !== undefined && typeof patch.rawRequestLogging !== 'boolean') throw new Error('rawRequestLogging must be boolean');
    const env = { HOST: this.config.host, PORT: String(this.config.port) };
    for (const [key, name] of Object.entries(editable)) {
      const value = Object.hasOwn(patch, key) ? patch[key] : this.config[key];
      env[name] = key === 'maxConcurrent' && value == null ? '' : String(value);
    }
    env.SSE_DONE_SENTINEL = String(patch.doneSentinel ?? this.config.doneSentinel);
    env.RAW_REQUEST_LOGGING = String(patch.rawRequestLogging ?? this.config.rawRequestLogging);
    const directEdits = patch.directEdits ?? this.config.directEdits;
    if (typeof directEdits !== 'boolean') throw new Error('directEdits must be boolean');
    env.DIRECT_EDITS = String(directEdits);
    const base = loadConfig(env);
    const sub2apiBase = String(patch.sub2apiBase ?? this.config.sub2apiBase ?? new URL(base.upstreamURL).origin);
    const parsed = new URL(sub2apiBase);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('sub2api 地址必须为不含凭据、查询参数的 HTTP(S) URL');
    }
    const sub2apiKey = patch.sub2apiKey ?? this.config.sub2apiKey ?? '';
    if (typeof sub2apiKey !== 'string' || sub2apiKey.length > 4096) throw new Error('管理员 Key 格式不正确');
    return { ...base, sub2apiBase: parsed.toString().replace(/\/+$/, ''), sub2apiKey };
  }
  publicSettings() {
    const out = {};
    for (const name of [...Object.keys(editable), 'doneSentinel', 'directEdits', 'rawRequestLogging', 'sub2apiBase']) {
      if (!secretNames.includes(name)) out[name] = this.config[name];
    }
    for (const name of secretNames) out[`${name}Configured`] = Boolean(this.config[name]);
    return out;
  }
  async saveSettings(patch) {
    for (const name of Object.keys(patch)) {
      if (![...Object.keys(editable), 'doneSentinel', 'directEdits', 'rawRequestLogging', 'sub2apiBase', 'sub2apiKey'].includes(name)) throw new Error(`未知设置：${name}`);
    }
    // Serialize concurrent settings updates to prevent memory/disk divergence.
    const operation = this.updated.catch(() => {}).then(async () => {
      const next = this.validate(patch);
      const saved = {};
      for (const name of [...Object.keys(editable), 'doneSentinel', 'directEdits', 'rawRequestLogging', 'sub2apiBase', 'sub2apiKey']) {
        saved[name] = secretNames.includes(name) && next[name] ? this.encrypt(next[name]) : next[name];
      }
      await atomic(path.join(this.directory, 'settings.json'), JSON.stringify(saved, null, 2));
      Object.assign(this.config, next);
      this.onConfigChanged?.();
    });
    this.updated = operation.catch(() => {});
    await operation;
    return this.publicSettings();
  }
  track(id, fields, cancel) {
    const old = this.live.get(id);
    const at = Date.now();
    const timeline = fields.phase && fields.phase !== old?.phase ?
      [...(old?.timeline || []), { phase: fields.phase, at }] : old?.timeline;
    this.live.set(id, { ...old, ...fields, timeline, updated_at: at, request_id: id,
      cancel: cancel || old?.cancel });
  }
  finish(row) {
    const current = this.live.get(row.request_id);
    this.live.delete(row.request_id);
    const { cancel, ...safe } = current || {};
    this.rows.unshift({ ...safe, ...row, updated_at: Date.now(),
      timeline: [...(safe.timeline || []), { phase: 'finished', at: Date.now() }] });
    const removed = this.rows.filter(item => item.started_at < Date.now() - logWindowMs).map(item => item.request_id);
    this.rows = this.rows.filter(item => item.started_at >= Date.now() - logWindowMs);
    this.updated = this.updated.catch(() => {}).then(async () => {
      await atomic(path.join(this.directory, 'requests.json'), JSON.stringify(this.rows));
      await this.removeRawRequests(removed);
      this.persistError = false;
    }).catch(() => { this.persistError = true; });
  }
  prune() {
    const removed = this.rows.filter(item => item.started_at < Date.now() - logWindowMs).map(item => item.request_id);
    const before = this.rows.length;
    this.rows = this.rows.filter(item => item.started_at >= Date.now() - logWindowMs);
    if (this.rows.length !== before) {
      this.updated = this.updated.catch(() => {}).then(async () => {
        await atomic(path.join(this.directory, 'requests.json'), JSON.stringify(this.rows));
        await this.removeRawRequests(removed);
      })
        .then(() => { this.persistError = false; }, () => { this.persistError = true; });
    }
  }
  cancel(id) {
    const row = this.live.get(id);
    if (!row?.cancel) return false;
    row.cancel();
    return true;
  }
  async persistRows() {
    const operation = this.updated.catch(() => {}).then(async () => {
      await atomic(path.join(this.directory, 'requests.json'), JSON.stringify(this.rows));
      this.persistError = false;
    });
    this.updated = operation.catch(() => { this.persistError = true; });
    await operation;
  }
  rawPath(id) {
    if (!requestID.test(id)) throw new Error('Invalid request ID');
    return path.join(this.rawDirectory, `${id}.json`);
  }
  async captureRawRequest(id, request) {
    try { await atomic(this.rawPath(id), JSON.stringify(request)); }
    catch (error) { this.persistError = true; throw error; }
  }
  async rawRequest(id) {
    try { return JSON.parse(await readFile(this.rawPath(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async removeRawRequests(ids) {
    await Promise.all(ids.map(id => rm(this.rawPath(id), { force: true })));
  }
  async pruneRawRequests(keep = new Set(this.rows.map(row => row.request_id))) {
    const files = await readdir(this.rawDirectory, { withFileTypes: true });
    await Promise.all(files.filter(file => file.isFile() && file.name.endsWith('.json'))
      .map(file => file.name.slice(0, -5)).filter(id => !keep.has(id) || !requestID.test(id))
      .map(id => rm(path.join(this.rawDirectory, `${id}.json`), { force: true })));
  }
  async deleteRequest(id) {
    if (this.live.has(id)) return 'active';
    const index = this.rows.findIndex(row => row.request_id === id);
    if (index === -1) return 'missing';
    this.rows.splice(index, 1);
    await this.persistRows();
    await this.removeRawRequests([id]);
    return 'deleted';
  }
  async clearHistory() {
    const ids = this.rows.map(row => row.request_id);
    const deleted = this.rows.length;
    this.rows = [];
    await this.persistRows();
    await this.removeRawRequests(ids);
    return deleted;
  }
  allRows() {
    return [...this.live.values()].map(({ cancel, ...rest }) => ({ ...rest, elapsed_ms: Date.now() - rest.started_at }))
      .concat(this.rows.filter(row => row.started_at >= Date.now() - logWindowMs));
  }
  summary() {
    const recent = this.rows.filter(row => row.started_at >= Date.now() - logWindowMs);
    const completed = recent.filter(row => row.outcome === 'completed').length;
    const durations = recent.filter(row => row.outcome === 'completed').map(row => row.elapsed_ms).sort((a, b) => a - b);
    return {
      total: recent.length, completed, failed: recent.length - completed,
      successRate: recent.length ? completed / recent.length : null,
      medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
      paused: this.paused, persistError: this.persistError,
    };
  }
}
