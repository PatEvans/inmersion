// Before/after on informal chat: old prompt with no context vs new prompt + neighbouring
// messages as context, both in the small on-screen batches. Blind-judged by Opus 5.5.
//   node bench/chat.mjs <chat.json> <old prompt module dir>
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client } from "./client.mjs";
import { translateWithClaude, chunkTexts } from "../src/shared/claude.js";

const [chatFile, oldDir] = process.argv.slice(2);
const lines = JSON.parse(fs.readFileSync(chatFile, "utf8"));
const old = await import(path.resolve(oldDir, "shared/prompt.js"));
const ctx = { url: "https://web.whatsapp.com/", title: "WhatsApp" };
const chunks = chunkTexts(lines.map((t, i) => ({ t, i })), { size: (x) => x.t.length, maxChars: 250, maxUnits: 8 });

async function run(variant) {
  const out = new Array(lines.length);
  let cost = 0;
  await Promise.all(chunks.map(async (chunk) => {
    const first = chunk[0].i, last = chunk.at(-1).i;
    const isOld = variant.startsWith("old");
    const c = isOld ? ctx : { ...ctx, before: lines.slice(Math.max(0, first - 4), first).join(" · "), after: lines.slice(last + 1, last + 3).join(" · ") };
    const r = await translateWithClaude(client, {
      texts: chunk.map((x) => x.t), lang: "es-ES", ctx: c,
      ...(isOld ? { system: old.systemPrompt("es-ES"), message: old.userMessage(chunk.map((x) => x.t), ctx) } : {}),
      ...(variant === "new+thinking" ? { thinking: "adaptive", effort: "medium" } : {}),
      onResult: (k, text) => (out[chunk[k].i] = text),
    });
    cost += r.cost;
  }));
  return { out, cost };
}
const VARIANTS = ["old", "old (again)", "new", "new+thinking"];
const T = {};
for (const v of VARIANTS) T[v] = await run(v);

// One blind pass: each line shows all four translations in a shuffled order.
let seed = 11; const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const order = lines.map(() => [...VARIANTS].sort(() => rand() - 0.5));
const Item = z.object({ id: z.number().int(), A: z.number().int().min(1).max(5), B: z.number().int().min(1).max(5), C: z.number().int().min(1).max(5), D: z.number().int().min(1).max(5) });
const res = await client.messages.parse({
  model: "claude-opus-5-5", max_tokens: 16000, output_config: { effort: "low", format: zodOutputFormat(z.object({ items: z.array(Item) })) },
  system: "You are a native Spain-Spanish (es-ES) speaker reviewing machine translations of an informal English WhatsApp chat between two friends. The full English chat is given for context. For each line, rate each translation A-D from 1-5 for how well it conveys what the sender actually meant, in natural texting Spanish from Spain (5 = exactly what a Spanish friend would text, 3 = understandable but off or stiff, 1 = wrong meaning). Identical translations get identical scores.",
  messages: [{ role: "user", content: "Full chat (English):\n" + lines.map((l, i) => `${i}: ${l}`).join("\n") + "\n\nTranslations:\n" + lines.map((l, i) => `### ${i}: ${l}\n` + order[i].map((v, k) => `${"ABCD"[k]}: ${T[v].out[i]}`).join("\n")).join("\n") }],
});
const score = Object.fromEntries(VARIANTS.map((v) => [v, []]));
for (const it of res.parsed_output.items) order[it.id].forEach((v, k) => score[v].push(it["ABCD"[k]]));
const avg = (xs) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
const vs = (a, b) => { let w = 0, l = 0; score[a].forEach((x, i) => { if (x > score[b][i]) w++; if (x < score[b][i]) l++; }); return `${w} better / ${l} worse`; };
for (const v of VARIANTS) console.log(`${v.padEnd(14)} ${avg(score[v])}  cost $${T[v].cost.toFixed(5)}  ${v === "old" ? "" : "vs old: " + vs(v, "old")}`);
const wrong = (v) => score[v].filter((x) => x <= 2).length;
console.log("lines scored ≤2 (wrong meaning):", VARIANTS.map((v) => `${v} ${wrong(v)}`).join(" | "));
