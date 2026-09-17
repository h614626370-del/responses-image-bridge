import http from 'node:http';
import https from 'node:https';
import { BridgeError } from './upstream.js';

function pick(item, fields) {
  const result = {};
  for (const key of fields) {
    const value = item?.[key];
    if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) result[key] = value;
  }
  return result;
}
function sanitize(kind, data) {
  const list = Array.isArray(data) ? data : (data?.items || []);
  const fields = kind === 'accounts' ? [
    'id', 'name', 'platform', 'type', 'status', 'schedulable', 'concurrency', 'priority',
    'rate_limit_reset_at', 'temp_unschedulable_until', 'last_used_at', 'overload_until',
  ] : kind === 'groups' ? ['id', 'name', 'platform', 'status'] : [
    'id', 'request_id', 'account_id', 'group_id', 'model', 'upstream_model', 'created_at',
    'duration_ms', 'first_token_ms', 'total_cost', 'actual_cost', 'image_count', 'stream',
  ];
  return { items: list.map(item => pick(item, fields)),
    total: Array.isArray(data) ? list.length : Number(data?.total || 0),
    page: Number(data?.page || 1), pages: Number(data?.pages || 1) };
}
export async function querySub2api(config, kind, params = {}) {
  if (!config.sub2apiKey) throw new BridgeError(400, 'admin_key_missing', '请先配置 sub2api 管理员 Key');
  const base = new URL(config.sub2apiBase);
  let prefix = base.pathname.replace(/\/+$/, '');
  if (!prefix.endsWith('/api/v1')) prefix += '/api/v1';
  const endpoints = { accounts: '/admin/accounts', groups: '/admin/groups/all', usage: '/admin/usage' };
  if (!endpoints[kind]) throw new BridgeError(400, 'invalid_query', 'Unsupported admin query');
  base.pathname = prefix + endpoints[kind];
  if (kind === 'accounts') {
    base.searchParams.set('platform', 'openai');
    base.searchParams.set('lite', 'true');
    if (params.group && /^\d+$/.test(params.group)) base.searchParams.set('group', params.group);
    if (params.search) base.searchParams.set('search', String(params.search).slice(0, 100));
  }
  if (kind !== 'groups') {
    base.searchParams.set('page', /^\d+$/.test(params.page || '') ? params.page : '1');
    base.searchParams.set('page_size', '50');
  }
  if (kind === 'usage') {
    if (!params.request_id || params.request_id.length > 200) throw new BridgeError(400, 'request_id_required', '关联查询需要上游 request ID');
    base.searchParams.set('request_id', params.request_id);
  }
  const signal = AbortSignal.timeout(15000);
  return await new Promise((resolve, reject) => {
      const req = (base.protocol === 'https:' ? https : http).request(base, {
        method: 'GET', signal, agent: false,
        headers: { 'x-api-key': config.sub2apiKey, Accept: 'application/json', 'Accept-Encoding': 'identity' },
      }, res => {
        const chunks = [];
        let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 8 * 1024 ** 2) {
            reject(new BridgeError(502, 'admin_response_limit', '管理员接口返回过大'));
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new BridgeError(502, 'admin_upstream_error', `sub2api 管理员接口返回 HTTP ${res.statusCode}`));
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (body.code !== 0 || !body.data) throw new Error();
            resolve(sanitize(kind, body.data));
          } catch { reject(new BridgeError(502, 'admin_protocol_error', '管理员接口格式不符，请检查地址与版本')); }
        });
      });
      req.on('error', () => reject(new BridgeError(502, 'admin_connection_error', '管理员接口连接失败或超时')));
      req.end();
    });
}
