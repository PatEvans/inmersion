// Unit test for the Google fallback with a fake fetch: batching, merged-line recovery,
// and backing off on a 429 without retrying.
import assert from "node:assert/strict";
let calls = [];
let mode = "ok";
globalThis.fetch = async (url, opts) => {
  const q = decodeURIComponent(opts.body.slice(2));
  calls.push(q);
  if (mode === "429") return new Response("<html>captcha</html>", { status: 429 });
  const lines = q.split("\n").map((l) => "ES:" + l);
  const text = mode === "merge" && lines.length > 1 ? lines.join(" ") : lines.join("\n");
  // Google returns sentence segments; the newline sits at the end of a segment.
  return new Response(JSON.stringify([text.split(/(?<=\n)/).map((seg) => [seg, "src"])]), { status: 200 });
};
const g = await import("../src/background/google.js");
const out = [];
await g.googleTranslate(["Sign in", "Posted by <1>me</1>", "Settings"], "es-ES", (i, t) => (out[i] = t));
assert.deepEqual(out, ["ES:Sign in", "ES:Posted by <1>me</1>", "ES:Settings"]);
assert.equal(calls.length, 1, "three short lines go in one request");
console.log("✓ batches lines into one request");

mode = "merge"; calls = []; out.length = 0;
await g.googleTranslate(["A", "B"], "es-ES", (i, t) => (out[i] = t));
assert.deepEqual(out, ["ES:A", "ES:B"]);
assert.equal(calls.length, 3, "merged batch is redone line by line");
console.log("✓ recovers when Google merges lines");

mode = "429"; calls = [];
await assert.rejects(g.googleTranslate(["Hello"], "es-ES", () => {}), /google-blocked/);
assert.equal(g.googleAvailable(), false);
mode = "ok";
await assert.rejects(g.googleTranslate(["Hello"], "es-ES", () => {}), /google-blocked/);
assert.equal(calls.length, 1, "no further requests while backing off");
console.log(`✓ backs off on 429 without retrying (blocked for ${Math.round((g.googleBlockedUntil() - Date.now()) / 60000)} min)`);
