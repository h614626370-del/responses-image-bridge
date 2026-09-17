import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { querySub2api } from './sub2api.js';
import { readJSON } from './server.js';

const publicDir = new URL('../public/', import.meta.url);
function equal(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  const body = await readJSON(req, 16384);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求必须为 JSON 对象');
  return body;
}
export function createManagement(state) {
  const sessions = new Map();
  const attempts = new Map();
  let server;
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    if (p !== '/' && !p.startsWith('/admin')) return false;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const icon = /^\/admin\/icons\/(activity|download|log-out|pause|play|refresh-cw|save|search|server|settings|x)\.svg$/.exec(p);
      if (req.method === 'GET' && (icon || ['/', '/admin', '/admin/', '/admin/app.js', '/admin/style.css', '/admin/icon.svg'].includes(p))) {
        const name = icon ? `icons/${icon[1]}.svg` : p.endsWith('app.js') ? 'app.js' : p.endsWith('style.css') ? 'style.css' : p.endsWith('icon.svg') ? 'icon.svg' : 'index.html';
        const file = await readFile(fileURLToPath(new URL(name, publicDir)));
        res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(file);
        return true;
      }
      if (!p.startsWith('/admin/api/')) { json(res, 404, { error: 'Not found' }); return true; }
      // JSON + custom header + same-origin checks reject cross-site form/CSRF requests.
      if (req.headers['x-bridge-admin'] !== '1') { json(res, 403, { error: '管理请求头缺失' }); return true; }
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        json(res, 403, { error: '不允许跨域管理请求' }); return true;
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') { json(res, 403, { error: '不允许跨站请求' }); return true; }
      for (const [token, expires] of sessions) if (expires < Date.now()) sessions.delete(token);
      if (p === '/admin/api/login' && req.method === 'POST') {
        const address = req.socket.remoteAddress;
        const now = Date.now();
        for (const [ip, entry] of attempts) if (entry.until < now) attempts.delete(ip);
        const entry = attempts.get(address) || { count: 0, until: now + 60000 };
        if (entry.count >= 10) { json(res, 429, { error: '尝试过多，请一分钟后重试' }); return true; }
        const body = await readBody(req);
        if (typeof body.key !== 'string' || !equal(body.key, state.loginKey)) {
          entry.count++;
          if (attempts.size < 1000) attempts.set(address, entry);
          json(res, 401, { error: '管理口令不正确' }); return true;
        }
        attempts.delete(address);
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        const token = randomBytes(32).toString('hex');
        sessions.set(token, now + 8 * 3600000);
        const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
        res.setHeader('Set-Cookie', `bridge_admin=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`);
        json(res, 200, { ok: true }); return true;
      }
      const token = /(?:^|;\s*)bridge_admin=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
      if (!token || !sessions.has(token)) { json(res, 401, { error: '请先登录' }); return true; }
      if (p === '/admin/api/logout' && req.method === 'POST') {
        sessions.delete(token);
        res.setHeader('Set-Cookie', 'bridge_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0');
        json(res, 200, { ok: true });
      } else if (p === '/admin/api/status' && req.method === 'GET') {
        json(res, 200, { ...state.summary(), active: server.queue.active, queued: server.queue.waiting.length,
          logWindowHours: 12, settings: state.publicSettings(), uptime: process.uptime() });
      } else if (p === '/admin/api/settings' && req.method === 'PUT') {
        json(res, 200, await state.saveSettings(await readBody(req)));
      } else if (p === '/admin/api/requests' && req.method === 'GET') {
        let rows = state.allRows();
        const status = url.searchParams.get('status');
        const route = url.searchParams.get('route');
        const search = (url.searchParams.get('search') || '').slice(0, 200).toLowerCase();
        if (status) rows = rows.filter(row => row.outcome === status);
        if (route) rows = rows.filter(row => row.route === route);
        if (search) rows = rows.filter(row => [row.request_id, row.upstream_request_id, row.upstream_response_id, row.error_code].some(value => String(value || '').toLowerCase().includes(search)));
        const page = Math.max(1, Math.min(100, Math.floor(Number(url.searchParams.get('page'))) || 1));
        json(res, 200, { items: rows.slice((page - 1) * 30, page * 30), total: rows.length, page, pages: Math.max(1, Math.ceil(rows.length / 30)) });
      } else if (p === '/admin/api/export' && req.method === 'GET') {
        res.setHeader('Content-Disposition', 'attachment; filename="bridge-requests.json"');
        json(res, 200, state.allRows());
      } else if (/^\/admin\/api\/requests\/[a-f0-9-]+\/cancel$/.test(p) && req.method === 'POST') {
        const canceled = state.cancel(p.split('/')[4]);
        json(res, canceled ? 200 : 404, { ok: canceled, error: canceled ? undefined : '请求已结束' });
      } else if (p === '/admin/api/pause' && req.method === 'POST') {
        const body = await readBody(req);
        if (typeof body.paused !== 'boolean') throw new Error('paused 必须为布尔值');
        state.paused = body.paused;
        json(res, 200, { paused: state.paused });
      } else if (['/admin/api/sub2api/accounts', '/admin/api/sub2api/groups', '/admin/api/sub2api/usage'].includes(p) && req.method === 'GET') {
        json(res, 200, await querySub2api({ ...state.config }, p.split('/').at(-1), Object.fromEntries(url.searchParams)));
      } else json(res, 404, { error: 'Not found' });
    } catch (err) {
      const known = err.status || (err instanceof SyntaxError ? 400 : 400);
      json(res, known, { error: err.message?.includes('EN') ? '本地读写失败' : err.message || '操作失败' });
    }
    return true;
  };
  handler.attach = instance => { server = instance; };
  return handler;
}
