import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { BlockList } from 'node:net';
import sharp from 'sharp';
import { BridgeError } from './upstream.js';

const maxImageBytes = 20 * 1024 * 1024;
const maxImagePixels = 40_000_000;
const maxRedirects = 3;
const downloadTimeoutMs = 30000;
const allowedOptions = ['size', 'quality', 'background', 'output_format', 'output_compression',
  'moderation', 'input_fidelity', 'style'];
const blockedAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10],
  ['ff00::', 8], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
]) blockedAddresses.addSubnet(address, prefix, 'ipv6');

function bad(message) {
  throw new BridgeError(400, 'direct_edit_unsupported', message);
}

function inspectImage(bytes, declaredMime) {
  if (!bytes.length || bytes.length > maxImageBytes) bad('Each source image must be between 1 byte and 20 MiB');
  const mime = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png' :
    bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' :
      bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '';
  if (!mime) bad('Source image must contain valid PNG, JPEG or WebP data');
  if (declaredMime && mime !== declaredMime) bad('Source image contents do not match its declared type');
  return { bytes, mime };
}

function decodeImage(part) {
  if (part.file_id) bad('Direct edits do not support file_id; provide an image data URL');
  const value = part.image_url;
  if (typeof value !== 'string') bad('Direct edits require an image data URL or HTTPS URL');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (match) {
    if (match[2].length % 4) bad('Invalid base64 image data');
    return inspectImage(Buffer.from(match[2], 'base64'), match[1].toLowerCase());
  }
  let url;
  try { url = new URL(value); } catch { bad('Direct edits support only base64 image data or HTTPS image URLs'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    bad('Remote source images must use an HTTPS URL without embedded credentials');
  }
  return { url: url.toString() };
}

async function publicAddress(hostname) {
  let addresses;
  try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new BridgeError(400, 'image_download_failed', 'Could not resolve the source image host'); }
  if (!addresses.length || addresses.some(({ address, family }) =>
    family === 6 && address.toLowerCase().startsWith('::ffff:') ||
    blockedAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4'))) {
    throw new BridgeError(400, 'image_url_blocked', 'Source image URL resolves to a private or reserved address');
  }
  return addresses[0];
}

export async function downloadRemoteImage(value, signal, redirects = 0) {
  let url;
  try { url = new URL(value); } catch { bad('Invalid source image URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    bad('Remote source images must use an HTTPS URL without embedded credentials');
  }
  if (redirects > maxRedirects) {
    throw new BridgeError(400, 'image_download_failed', 'Source image redirected too many times');
  }
  const address = await publicAddress(url.hostname);
  const timeoutSignal = AbortSignal.timeout(downloadTimeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return await new Promise((resolve, reject) => {
    const request = https.get(url, {
      agent: false,
      signal: requestSignal,
      headers: { Accept: 'image/png,image/jpeg,image/webp,*/*;q=0.1', 'Accept-Encoding': 'identity' },
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        let destination;
        try { destination = new URL(response.headers.location, url).toString(); }
        catch {
          reject(new BridgeError(400, 'image_download_failed', 'Source image returned an invalid redirect'));
          return;
        }
        resolve(downloadRemoteImage(destination, signal, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new BridgeError(400, 'image_download_failed', `Source image returned HTTP ${response.statusCode}`));
        return;
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.resume();
        reject(new BridgeError(400, 'image_download_failed', 'Compressed source images are not supported'));
        return;
      }
      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxImageBytes) {
        response.resume();
        reject(new BridgeError(413, 'image_too_large', 'Source image exceeds 20 MiB'));
        return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxImageBytes) {
          const error = new BridgeError(413, 'image_too_large', 'Source image exceeds 20 MiB');
          reject(error);
          response.destroy(error);
        } else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(inspectImage(Buffer.concat(chunks))); } catch (error) { reject(error); }
      });
    });
    request.on('error', error => {
      if (signal?.aborted) reject(signal.reason);
      else if (timeoutSignal.aborted) {
        reject(new BridgeError(504, 'image_download_timeout', 'Timed out while downloading the source image'));
      }
      else reject(new BridgeError(400, 'image_download_failed', 'Could not download the source image'));
    });
  });
}

export function imageInputPresent(body) {
  return Array.isArray(body.input) && body.input.some(item =>
    item?.type === 'input_image' || (Array.isArray(item?.content) && item.content.some(part => part?.type === 'input_image')));
}

export function parseDirectEdit(body) {
  if (!imageInputPresent(body)) return null;
  if (body.previous_response_id || body.conversation) bad('Direct edits do not support multi-turn conversations');
  if (typeof body.instructions !== 'undefined' && typeof body.instructions !== 'string') bad('instructions must be text');
  if (!Array.isArray(body.tools) || body.tools.length !== 1 || body.tools[0]?.type !== 'image_generation') {
    bad('Direct edits require exactly one image_generation tool');
  }
  const tool = body.tools[0];
  if (typeof tool.model !== 'string' || !/^gpt-image-[a-zA-Z0-9.-]+$/.test(tool.model)) {
    bad('Direct edits require a GPT image model in tools[0].model');
  }
  if (tool.n !== undefined && tool.n !== 1) bad('Direct edits support exactly one output image');
  if (tool.action && !['generate', 'edit'].includes(tool.action)) bad('Unsupported image action');
  if (body.input.length !== 1 || body.input[0]?.role !== 'user' ||
      !Array.isArray(body.input[0].content)) bad('Direct edits require one user message with image content');

  const images = [];
  const texts = [];
  for (const part of body.input[0].content) {
    if (part?.type === 'input_image') images.push(decodeImage(part));
    else if (part?.type === 'input_text' && typeof part.text === 'string') texts.push(part.text);
    else bad('Direct edits accept only input_text and input_image content');
  }
  if (images.length > 8) bad('Direct edits support at most eight source images');
  const prompt = [body.instructions, ...texts].filter(Boolean).join('\n\n').trim();
  if (!prompt) bad('Direct edits require a text prompt');
  const options = {};
  for (const name of allowedOptions) {
    if (tool[name] === undefined) continue;
    const value = tool[name];
    if (name === 'output_compression' ? !Number.isInteger(value) || value < 0 || value > 100 :
      typeof value !== 'string' || !value.trim()) bad(`Invalid image option: ${name}`);
    options[name] = value;
  }
  let mask;
  if (tool.input_image_mask !== undefined) {
    if (!tool.input_image_mask || typeof tool.input_image_mask !== 'object') bad('Invalid image mask');
    mask = decodeImage(tool.input_image_mask);
  }
  const remoteCount = images.filter(image => image.url).length + Number(Boolean(mask?.url));
  return { model: tool.model, prompt, images, mask, options, remoteCount };
}

export async function materializeDirectEdit(spec, signal, loader = downloadRemoteImage) {
  async function materialize(image) {
    if (!image?.url) return image;
    const downloaded = await loader(image.url, signal);
    try {
      const bytes = await sharp(downloaded.bytes, { limitInputPixels: maxImagePixels })
        .webp({ lossless: true })
        .toBuffer();
      if (!bytes.length || bytes.length > maxImageBytes) {
        throw new BridgeError(413, 'image_too_large', 'Converted source image exceeds 20 MiB');
      }
      return { bytes, mime: 'image/webp' };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(400, 'image_conversion_failed', 'Could not convert the remote source image');
    }
  }
  return {
    ...spec,
    images: await Promise.all(spec.images.map(materialize)),
    mask: spec.mask ? await materialize(spec.mask) : undefined,
  };
}

export function wrapDirectEdit(result, spec, requestedModel) {
  const data = result?.data;
  if (!Array.isArray(data) || data.length !== 1 || typeof data[0]?.b64_json !== 'string' || !data[0].b64_json) {
    throw new BridgeError(502, 'image_missing', 'Images edit response must contain exactly one base64 image');
  }
  const id = randomUUID().replaceAll('-', '');
  const now = Math.floor(Date.now() / 1000);
  const item = { id: `ig_bridge_${id}`, type: 'image_generation_call', status: 'completed', result: data[0].b64_json };
  if (typeof data[0].revised_prompt === 'string') item.revised_prompt = data[0].revised_prompt;
  if (typeof result.output_format === 'string') item.output_format = result.output_format;
  else if (spec.options.output_format) item.output_format = spec.options.output_format;
  return { id: `resp_bridge_${id}`, object: 'response', created_at: now, completed_at: now,
    status: 'completed', model: requestedModel, output: [item], error: null, usage: result.usage || null };
}
