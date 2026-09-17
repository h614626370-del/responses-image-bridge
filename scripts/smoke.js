import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Explicitly opt-in: this creates ONE paid upstream image request.
if (!process.argv.includes('--live')) {
  console.log('No request sent. To run one paid image test: npm run smoke -- --live');
  process.exit(0);
}
const key = process.env.SMOKE_API_KEY;
if (!key) throw new Error('Set SMOKE_API_KEY in the process environment');
const base = (process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const imagePath = process.env.SMOKE_IMAGE_PATH;
let input = 'Generate exactly one photorealistic image of an alpine lake and snowy mountains. No text or logos.';
if (imagePath) {
  const bytes = await readFile(imagePath);
  const mime = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png' :
    bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' :
      bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
  if (!mime) throw new Error('SMOKE_IMAGE_PATH must point to a PNG, JPEG or WebP image');
  input = [{ role: 'user', content: [
    { type: 'input_text', text: process.env.SMOKE_PROMPT || 'Change the background while preserving the main subject. No text or logos.' },
    { type: 'input_image', image_url: `data:${mime};base64,${bytes.toString('base64')}` },
  ] }];
}
const begin = Date.now();
const response = await fetch(`${base}/v1/responses`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'gpt-5.5', stream: true,
    input,
    tools: [{ type: 'image_generation', model: 'gpt-image-2',
      action: imagePath ? 'edit' : 'generate', quality: 'high', output_format: 'png' }],
  }),
  signal: AbortSignal.timeout(960000),
});
if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Expected SSE');
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let terminal;
let heartbeats = 0;
const eventLog = [];
function consume(frame) {
  if (frame.startsWith(':')) { heartbeats++; return; }
  const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return;
  const event = JSON.parse(data);
  const elapsed = Math.round((Date.now() - begin) / 10) / 100;
  eventLog.push({ type: event.type, seconds: elapsed });
  console.log(`${elapsed}s ${event.type}`);
  if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) terminal = event.response;
}
while (true) {
  const { value, done } = await reader.read();
  buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
  buffer = buffer.replaceAll('\r\n', '\n');
  let end;
  while ((end = buffer.indexOf('\n\n')) !== -1) {
    consume(buffer.slice(0, end));
    buffer = buffer.slice(end + 2);
  }
  if (done) break;
}
const dir = path.resolve('output', `smoke-${Date.now()}`);
await mkdir(dir, { recursive: true });
let images = 0;
for (const item of terminal?.output || []) {
  if (item.type !== 'image_generation_call' || !item.result) continue;
  const bytes = Buffer.from(item.result, 'base64');
  const extension = item.output_format === 'jpeg' ? 'jpg' : item.output_format === 'webp' ? 'webp' : 'png';
  const file = path.join(dir, `image-${++images}.${extension}`);
  await writeFile(file, bytes);
  item.result = `[Saved: ${file}]`;
}
await writeFile(path.join(dir, 'result.json'), JSON.stringify({
  heartbeats, eventLog, response: terminal, images, elapsed_seconds: (Date.now() - begin) / 1000,
}, null, 2));
console.log(`Saved ${images} images and event log to ${dir}`);
if (terminal?.status !== 'completed' || images !== 1) process.exitCode = 1;
