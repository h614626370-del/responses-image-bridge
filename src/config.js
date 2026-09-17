export function loadConfig(env = process.env) {
  function integer(name, fallback, min, max) {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`${name} must be an integer in [${min}, ${max}]`);
    }
    return n;
  }
  const base = new URL(env.UPSTREAM_BASE_URL || 'https://kkflow.org');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('UPSTREAM_BASE_URL must be an HTTP(S) URL without credentials, query or fragment');
  }
  const suffix = base.pathname.replace(/\/+$/, '');
  base.pathname = /\/responses$/.test(suffix) ? suffix :
    /\/v1$/.test(suffix) ? `${suffix}/responses` : `${suffix}/v1/responses`;
  const config = {
    host: env.HOST || '127.0.0.1',
    port: integer('PORT', 8787, 0, 65535),
    upstreamURL: base.toString(),
    controlModel: env.CONTROL_MODEL || 'gpt-5.6-luna',
    directEdits: env.DIRECT_EDITS !== 'false',
    heartbeatMs: integer('HEARTBEAT_MS', 5000, 10, 60000),
    maxConcurrent: env.MAX_CONCURRENT == null || String(env.MAX_CONCURRENT).trim() === '' ||
      env.MAX_CONCURRENT === 'null' ? null : integer('MAX_CONCURRENT', 4, 1, 100),
    maxQueue: integer('MAX_QUEUE', 60, 0, 1000),
    timeoutMs: integer('REQUEST_TIMEOUT_MS', 900000, 50, 3600000),
    maxBodyBytes: integer('MAX_BODY_BYTES', 32 * 1024 ** 2, 128, 256 * 1024 ** 2),
    maxResponseBytes: integer('MAX_RESPONSE_BYTES', 64 * 1024 ** 2, 128, 512 * 1024 ** 2),
    doneSentinel: env.SSE_DONE_SENTINEL === 'true',
  };
  if (env.DIRECT_EDITS !== undefined && !['true', 'false'].includes(env.DIRECT_EDITS)) {
    throw new Error('DIRECT_EDITS must be true or false');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(config.controlModel)) throw new Error('Invalid CONTROL_MODEL');
  return config;
}
