const safeValueKeys = new Set([
  'model', 'type', 'role', 'action', 'quality', 'size', 'output_format', 'background',
  'input_fidelity', 'style', 'moderation', 'detail', 'status', 'response_format',
]);
const secretKey = /(?:authorization|api[_-]?key|token|secret|password|credential|cookie)/i;
const imageKey = /(?:image|mask|b64|base64|file_data)/i;
const textKey = /(?:text|prompt|instruction|input|message|content)/i;
const maxDepth = 8;
const maxNodes = 240;
const maxArray = 20;
const maxKeys = 40;

function imagePlaceholder(value) {
  const match = /^data:([^;,]{1,100})(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
  if (!match) return `[redacted image string chars=${value.length}]`;
  const base64Chars = match[2].replace(/\s/g, '').length;
  return `[redacted ${match[1]} base64 chars=${base64Chars} approx_bytes=${Math.floor(base64Chars * 3 / 4)}]`;
}

function safeScalar(key, value) {
  if (secretKey.test(key)) return '[redacted secret]';
  if (imageKey.test(key)) return imagePlaceholder(value);
  if (safeValueKeys.has(key) && value.length <= 120 && /^[a-zA-Z0-9._:/-]+$/.test(value)) return value;
  if (textKey.test(key)) return `[redacted text chars=${value.length}]`;
  return `[redacted string chars=${value.length}]`;
}

export function sanitizeRequestBody(value) {
  let nodes = 0;
  function visit(current, key = '', depth = 0) {
    if (++nodes > maxNodes) return '[truncated: node limit]';
    if (depth > maxDepth) return '[truncated: depth limit]';
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number') return Number.isFinite(current) ? current : '[invalid number]';
    if (typeof current === 'string') return safeScalar(key, current);
    if (Array.isArray(current)) {
      const items = current.slice(0, maxArray).map(item => visit(item, key, depth + 1));
      if (current.length > maxArray) items.push(`[truncated: ${current.length - maxArray} array items]`);
      return items;
    }
    if (!current || typeof current !== 'object') return `[unsupported ${typeof current}]`;
    const output = {};
    const entries = Object.entries(current);
    for (const [rawKey, child] of entries.slice(0, maxKeys)) {
      const displayKey = rawKey.length <= 100 ? rawKey : `[key chars=${rawKey.length}]`;
      output[displayKey] = secretKey.test(rawKey) ? '[redacted secret]' : visit(child, rawKey, depth + 1);
    }
    if (entries.length > maxKeys) output.$truncated_keys = entries.length - maxKeys;
    return output;
  }
  return visit(value);
}

export function describeRequest(req, path, body) {
  const contentLength = Number(req.headers['content-length']);
  const description = {
    format_version: 1,
    method: req.method,
    path,
    content_type: String(req.headers['content-type'] || '').slice(0, 160) || null,
    content_encoding: String(req.headers['content-encoding'] || '').slice(0, 80) || null,
    content_length: Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null,
    header_names: Object.keys(req.headers).sort().slice(0, 50),
  };
  if (body !== undefined) description.body = sanitizeRequestBody(body);
  return description;
}
