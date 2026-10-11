// Claude engine: one streamed request per chunk of units. Each finished "N: …" line is
// handed to onResult immediately, so the page fills in while the model is still writing.

import { systemPrompt, userMessage, lineParser, costOf } from "./prompt.js";

export const DEFAULT_MODEL = "claude-haiku-5-5";

/** Split texts into request-sized chunks (small chunks = first words appear sooner). */
export function chunkTexts(items, { maxChars = 1000, maxUnits = 25, size = (x) => x.length } = {}) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  for (const item of items) {
    const n = size(item);
    if (cur.length && (chars + n > maxChars || cur.length >= maxUnits)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(item);
    chars += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Translate `texts` (plain or markup strings). Resolves with usage/cost/timing and the
 * indexes the model didn't return (the caller retries or falls back for those).
 */
export async function translateWithClaude(client, {
  texts, ctx, lang, model = DEFAULT_MODEL, effort = "low", thinking = "disabled", signal, onResult,
}) {
  const t0 = performance.now();
  let firstToken = null;
  let firstLine = null;
  const parser = lineParser(texts.length, (i, text) => {
    if (firstLine === null) firstLine = performance.now() - t0;
    onResult?.(i, text);
  });
  const chars = texts.reduce((s, t) => s + t.length, 0);
  // Output is ~1.1-1.3x the input tokens for Romance languages; keep generous headroom.
  const maxTokens = Math.min(16000, Math.ceil(chars / 1.2) + 40 * texts.length + 256);
  const stream = client.messages.stream(
    {
      model,
      max_tokens: maxTokens,
      ...(thinking === "disabled" ? { thinking: { type: "disabled" } } : {}),
      output_config: { effort },
      system: [{ type: "text", text: systemPrompt(lang), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMessage(texts, ctx) }],
    },
    { signal },
  );
  stream.on("text", (delta) => {
    if (firstToken === null) firstToken = performance.now() - t0;
    parser.push(delta);
  });
  const msg = await stream.finalMessage();
  const done = parser.end();
  return {
    usage: msg.usage,
    stop: msg.stop_reason,
    cost: costOf(model, msg.usage),
    ms: performance.now() - t0,
    firstToken,
    firstLine,
    missing: texts.map((_, i) => i).filter((i) => !done.has(i)),
    headers: stream.response?.headers,
  };
}
