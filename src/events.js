import { once } from 'node:events';

export async function writeFrame(res, frame, signal) {
  if (signal.aborted) throw signal.reason;
  if (res.destroyed) throw new Error('Client disconnected');
  if (!res.write(frame)) await once(res, 'drain', { signal });
}

export function eventWriter(res, signal) {
  let sequence = 0;
  return async (type, fields) => {
    const data = { ...fields, type, sequence_number: sequence++ };
    await writeFrame(res, `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`, signal);
  };
}

// Replay the final snapshot, retaining real upstream IDs. Before the snapshot
// arrives only SSE comments are sent; these events are not live progress.
export async function emitResponse(emit, response) {
  const start = { ...response, status: 'in_progress', output: [], error: null, usage: null, incomplete_details: null };
  delete start.completed_at;
  await emit('response.created', { response: start });
  await emit('response.in_progress', { response: start });
  for (const [output_index, item] of response.output.entries()) {
    const added = { ...item, status: 'in_progress' };
    if (item.type === 'image_generation_call') added.result = null;
    if (item.type === 'message') added.content = [];
    if (item.type === 'reasoning') added.summary = [];
    await emit('response.output_item.added', { output_index, item: added });
    if (item.type === 'message') {
      for (const [content_index, part] of (item.content || []).entries()) {
        const fields = { item_id: item.id, output_index, content_index };
        const empty = part.type === 'output_text' ? { ...part, text: '', annotations: [] } :
          part.type === 'refusal' ? { ...part, refusal: '' } : part;
        await emit('response.content_part.added', { ...fields, part: empty });
        if (part.type === 'output_text') {
          if (part.text) await emit('response.output_text.delta', { ...fields, delta: part.text, logprobs: [] });
          for (const [annotation_index, annotation] of (part.annotations || []).entries()) {
            await emit('response.output_text.annotation.added', { ...fields, annotation_index, annotation });
          }
          await emit('response.output_text.done', { ...fields, text: part.text, logprobs: part.logprobs || [] });
        } else if (part.type === 'refusal') {
          if (part.refusal) await emit('response.refusal.delta', { ...fields, delta: part.refusal });
          await emit('response.refusal.done', { ...fields, refusal: part.refusal });
        }
        await emit('response.content_part.done', { ...fields, part });
      }
    } else if (item.type === 'reasoning') {
      for (const [summary_index, part] of (item.summary || []).entries()) {
        const fields = { item_id: item.id, output_index, summary_index };
        await emit('response.reasoning_summary_part.added', { ...fields, part: { ...part, text: '' } });
        if (part.text) await emit('response.reasoning_summary_text.delta', { ...fields, delta: part.text });
        await emit('response.reasoning_summary_text.done', { ...fields, text: part.text || '' });
        await emit('response.reasoning_summary_part.done', { ...fields, part });
      }
    } else if (item.type === 'image_generation_call' && item.status === 'completed') {
      await emit('response.image_generation_call.completed', { item_id: item.id, output_index });
    }
    await emit('response.output_item.done', { output_index, item });
  }
  await emit(`response.${response.status}`, { response });
}
