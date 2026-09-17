import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Explicit opt-in: this issues 30 paid image edit requests at once.
if (!process.argv.includes('--live')) {
  console.log('No requests sent. Use --live with SMOKE_API_KEY and SMOKE_IMAGE_PATH.');
  process.exit(0);
}

const key = process.env.SMOKE_API_KEY;
const imagePath = process.env.SMOKE_IMAGE_PATH;
if (!key || !imagePath) throw new Error('Set SMOKE_API_KEY and SMOKE_IMAGE_PATH');
const bytes = await readFile(imagePath);
const mime = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png' :
  bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : null;
if (!mime) throw new Error('Test source must be a PNG or JPEG');

const base = (process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const count = 30;
const output = path.resolve('output', `concurrent-smoke-${Date.now()}`);
await mkdir(output, { recursive: true });
const body = JSON.stringify({
  model: 'gpt-5.5',
  stream: true,
  input: [{ role: 'user', content: [
    { type: 'input_text', text: process.env.SMOKE_PROMPT ||
      'Change the time of day to a warm sunset while preserving the alpine lake and mountain composition. No text or logos.' },
    { type: 'input_image', image_url: `data:${mime};base64,${bytes.toString('base64')}` },
  ] }],
  tools: [{ type: 'image_generation', model: 'gpt-image-2', action: 'edit',
    quality: 'high', output_format: 'png' }],
});

let inFlight = 0;
let peakInFlight = 0;
const results = [];
const batchStarted = Date.now();

async function runOne(index) {
  const number = String(index + 1).padStart(2, '0');
  const dir = path.join(output, `request-${number}`);
  const started = Date.now();
  const result = { number: index + 1, started_at: new Date(started).toISOString(),
    start_offset_ms: started - batchStarted, images: 0, heartbeats: 0, events: [] };
  inFlight++;
  peakInFlight = Math.max(peakInFlight, inFlight);
  try {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(960000),
    });
    result.http_status = response.status;
    if (!response.ok) {
      const error = await response.text();
      try { result.error = JSON.parse(error).error?.message || `HTTP ${response.status}`; }
      catch { result.error = `HTTP ${response.status}`; }
      return result;
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
      throw new Error('Expected a streaming response');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let terminal;
    function consume(frame) {
      if (frame.startsWith(':')) { result.heartbeats++; return; }
      const data = frame.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return;
      const event = JSON.parse(data);
      result.events.push(event.type);
      if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) {
        terminal = event.response;
      }
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
    result.status = terminal?.status || 'missing_terminal_event';
    result.error = terminal?.error?.message || null;
    for (const item of terminal?.output || []) {
      if (item.type !== 'image_generation_call' || !item.result) continue;
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `image-${++result.images}.png`);
      await writeFile(file, Buffer.from(item.result, 'base64'));
      result.image_path = file;
    }
    return result;
  } catch (error) {
    result.status = 'client_error';
    result.error = String(error.message || error).slice(0, 240);
    return result;
  } finally {
    inFlight--;
    result.elapsed_seconds = (Date.now() - started) / 1000;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    results.push(result);
    const success = result.status === 'completed' && result.images === 1;
    console.log(`${number}/30 ${success ? 'OK' : 'FAIL'} ${result.elapsed_seconds}s ` +
      `images=${result.images} heartbeats=${result.heartbeats} ` +
      `HTTP=${result.http_status ?? '-'} ${result.error || ''}`);
  }
}

console.log(`Launching ${count} simultaneous requests. Results: ${output}`);
await Promise.all(Array.from({ length: count }, (_, index) => runOne(index)));
results.sort((a, b) => a.number - b.number);
const summary = {
  requested: count, completed: results.filter(r => r.status === 'completed' && r.images === 1).length,
  failed: results.filter(r => r.status !== 'completed' || r.images !== 1).length,
  peak_client_in_flight: peakInFlight,
  launch_spread_ms: Math.max(...results.map(r => r.start_offset_ms)),
  elapsed_seconds: (Date.now() - batchStarted) / 1000,
  results,
};
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`Done: ${summary.completed}/${count} images, ${summary.elapsed_seconds}s. ${output}`);
if (summary.failed) process.exitCode = 1;
