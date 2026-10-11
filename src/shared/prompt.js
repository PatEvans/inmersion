// Prompt + wire format for the Claude engine. Lines go out as "N: text" and come back the
// same way, which streams well (each finished line is applied immediately) and costs ~2
// tokens of overhead per unit.

import { langInfo } from "./langs.js";

const EXAMPLE_SOURCE = [
  "Sign in",
  "Posted by <1>u/throwaway_42</1> 5 hours ago",
  "<1>Learn more</1> about how we use cookies.",
  "1.2K comments",
  "Settings",
  "I can't believe this actually worked lol",
  "Use the <1/> command to install it.",
  "The Prime Minister said the plan would <1>\"fix the economy\"</1>, but critics disagreed.<2/>",
];

export function systemPrompt(code) {
  const L = langInfo(code);
  const example = L.examples
    ? `

## Example
Input:
Page: Example — example.com
${EXAMPLE_SOURCE.map((s, i) => `${i + 1}: ${s}`).join("\n")}
Output:
${L.examples.map((s, i) => `${i + 1}: ${s}`).join("\n")}`
    : "";
  return `You are the translation engine of a browser extension that shows its user the entire web in ${L.name}. They are immersing themselves in the language, so your output replaces the original text on live web pages and must read as if the site had been written in ${L.name} in the first place.

## Input
A line with the page title and site, then numbered lines "N: text". Each numbered line is one piece of the same page: a heading, paragraph, menu item, button, link, comment, caption, timestamp. Use the other lines as context (a "Home" next to "News" and "Sport" is a menu item).

## Output
Exactly one line per numbered input line, same numbers, same order, formatted "N: translation". Nothing else: no notes, no blank lines, no code fences. Never merge or split lines.

## Rules
- Write natural, idiomatic ${L.name}, the way a native speaker would write that kind of text on a website. Keep the tone: casual comments stay casual, legal text stays formal, headlines stay punchy. Do not summarise, explain or censor.
- ${L.variant}
- Buttons, menus and tabs use the standard wording that ${L.name} websites and apps use.
- Keep unchanged: names of people, brands, products, services and channels; usernames, @handles and #hashtags; URLs, email addresses, file names and code; emoji. Format numbers, dates and counts the ${L.name} way.
- Tags: <1>…</1> wraps the text of a link or formatted span; <2/> marks something like an image, icon or code inside the sentence; <br> is a line break. Keep every tag exactly once with the same number, around or at the words that correspond to it in your translation, moving it when word order changes. Never add, drop or renumber tags.
- A line that is already in ${L.name}, or has nothing to translate (a name, a code, a number), is returned unchanged.${example}`;
}

export function userMessage(texts, ctx = {}) {
  let host = "";
  try {
    host = ctx.url ? new URL(ctx.url).hostname.replace(/^www\./, "") : "";
  } catch {}
  const title = (ctx.title || "").replace(/\s+/g, " ").slice(0, 150);
  const head = `Page: ${[title, host].filter(Boolean).join(" — ") || "unknown"}`;
  return `${head}\n${texts.map((t, i) => `${i + 1}: ${t}`).join("\n")}`;
}

/** Incremental parser for streamed "N: text" lines. Calls onLine(index0, text). */
export function lineParser(count, onLine) {
  let buf = "";
  let lastIdx = -1;
  const done = new Set();
  const handle = (line) => {
    const m = line.match(/^\s*(\d+)\s*[:.)]\s?(.*)$/);
    if (m) {
      const i = Number(m[1]) - 1;
      if (i >= 0 && i < count && !done.has(i)) {
        lastIdx = i;
        done.add(i);
        onLine(i, m[2]);
        return;
      }
    }
    // A stray continuation line: the model broke a line. Ignore it (the unit keeps the
    // first part; rare and harmless).
  };
  return {
    push(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    end() {
      if (buf.trim()) handle(buf);
      buf = "";
      return done;
    },
    get last() {
      return lastIdx;
    },
  };
}

// Claude Haiku 5.5 prices, USD per token (prompts up to 100K tokens).
export const PRICES = {
  "claude-haiku-5-5": { in: 0.1e-6, out: 0.5e-6, cacheRead: 0.01e-6, cacheWrite: 0.125e-6 },
  "claude-haiku-4-5": { in: 1e-6, out: 5e-6, cacheRead: 0.1e-6, cacheWrite: 1.25e-6 },
  "claude-sonnet-5-5": { in: 2e-6, out: 10e-6, cacheRead: 0.2e-6, cacheWrite: 2.5e-6 },
};

export function costOf(model, usage) {
  const p = PRICES[model] ?? PRICES["claude-haiku-5-5"];
  return (
    (usage.input_tokens ?? 0) * p.in +
    (usage.output_tokens ?? 0) * p.out +
    (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
    (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite
  );
}
