import http from 'node:http';
import https from 'node:https';

export class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function sendUpstream(config, url, payload, contentType, key, headers, signal, observe) {
  return await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'POST', signal, agent: false,
        headers: {
          ...headers,
          Authorization: `Bearer ${key}`,
          'Content-Type': contentType,
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          'Content-Length': payload.length,
        },
      }, response => {
        observe({ upstream_http_status: response.statusCode,
          upstream_request_id: String(response.headers['x-request-id'] || '').slice(0, 200) });
        let size = 0;
        const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > config.maxResponseBytes) {
            const err = new BridgeError(502, 'upstream_response_too_large', 'Upstream response exceeded the configured size limit');
            reject(err);
            response.destroy(err);
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch {
            const failed = response.statusCode < 200 || response.statusCode >= 300;
            reject(new BridgeError(failed && response.statusCode >= 400 ? response.statusCode : 502,
              failed ? 'upstream_http_error' : 'invalid_upstream_response',
              failed ? `Upstream returned HTTP ${response.statusCode} with a non-JSON error` :
                'Upstream returned non-JSON data; expected a synchronous Responses result'));
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new BridgeError(response.statusCode >= 400 ? response.statusCode : 502,
              json.error?.code || 'upstream_error',
              typeof json.error?.message === 'string' ? json.error.message : `Upstream HTTP ${response.statusCode}`));
            return;
          }
          resolve(json);
        });
      });
      request.on('error', reject);
      request.end(payload);
    });
}

export function callUpstream(config, body, key, headers, signal, observe = () => {}) {
  return sendUpstream(config, new URL(config.upstreamURL), Buffer.from(JSON.stringify(body)),
    'application/json', key, headers, signal, observe);
}

export async function callDirectEdit(config, spec, key, headers, signal, observe = () => {}) {
  const url = new URL(config.upstreamURL);
  url.pathname = url.pathname.replace(/\/responses$/, '/images/edits');
  const form = new FormData();
  form.set('model', spec.model);
  form.set('prompt', spec.prompt);
  form.set('n', '1');
  form.set('response_format', 'b64_json');
  for (const [name, value] of Object.entries(spec.options)) form.set(name, String(value));
  for (const [index, image] of spec.images.entries()) {
    const ext = image.mime === 'image/jpeg' ? 'jpg' : image.mime.split('/')[1];
    form.append('image', new Blob([image.bytes], { type: image.mime }), `source-${index + 1}.${ext}`);
  }
  if (spec.mask) {
    const ext = spec.mask.mime === 'image/jpeg' ? 'jpg' : spec.mask.mime.split('/')[1];
    form.set('mask', new Blob([spec.mask.bytes], { type: spec.mask.mime }), `mask.${ext}`);
  }
  const encoded = new Request(url, { method: 'POST', body: form });
  const payload = Buffer.from(await encoded.arrayBuffer());
  if (payload.length > config.maxBodyBytes) throw new BridgeError(413, 'request_too_large', 'Encoded edit request exceeds body limit');
  return sendUpstream(config, url, payload, encoded.headers.get('content-type'), key, headers, signal, observe);
}
