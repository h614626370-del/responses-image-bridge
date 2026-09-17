import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRequest, sanitizeRequestBody } from '../src/request-format.js';

test('request format preserves structure and options while redacting user data and secrets', () => {
  const body = {
    model: 'gpt-5.5', stream: true, api_key: 'private-key', instructions: 'private instructions',
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'private prompt' },
      { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
    ] }],
    tools: [{ type: 'image_generation', model: 'gpt-image-2', action: 'edit', quality: 'high' }],
  };
  const safe = sanitizeRequestBody(body);
  const text = JSON.stringify(safe);
  assert.equal(safe.model, 'gpt-5.5');
  assert.equal(safe.stream, true);
  assert.equal(safe.tools[0].type, 'image_generation');
  assert.equal(safe.tools[0].model, 'gpt-image-2');
  assert.match(safe.input[0].content[1].image_url, /image\/png.*approx_bytes/);
  assert.doesNotMatch(text, /private-key|private instructions|private prompt|aGVsbG8=/);
});

test('request description stores header names but never header values', () => {
  const req = { method: 'POST', headers: {
    authorization: 'Bearer private-key', 'content-type': 'application/json',
    'content-length': '123', 'x-client-version': 'private-version',
  } };
  const description = describeRequest(req, '/v1/responses', { model: 'gpt-5.5' });
  const text = JSON.stringify(description);
  assert.deepEqual(description.header_names,
    ['authorization', 'content-length', 'content-type', 'x-client-version']);
  assert.equal(description.content_length, 123);
  assert.doesNotMatch(text, /Bearer private-key|private-version/);
});
