import { randomUUID } from 'node:crypto';
import { BridgeError } from './upstream.js';

const maxImageBytes = 20 * 1024 * 1024;
const allowedOptions = ['size', 'quality', 'background', 'output_format', 'output_compression',
  'moderation', 'input_fidelity', 'style'];

function bad(message) {
  throw new BridgeError(400, 'direct_edit_unsupported', message);
}

function decodeImage(part) {
  if (part.file_id) bad('Direct edits do not support file_id; provide an image data URL');
  const value = part.image_url;
  if (typeof value !== 'string') bad('Direct edits require an image data URL');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match || match[2].length % 4) bad('Direct edits support only base64 PNG, JPEG or WebP data URLs');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxImageBytes) bad('Each source image must be between 1 byte and 20 MiB');
  const mime = match[1].toLowerCase();
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) :
    mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 :
      bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!valid) bad('Source image contents do not match its declared type');
  return { bytes, mime };
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
  return { model: tool.model, prompt, images, mask, options };
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
