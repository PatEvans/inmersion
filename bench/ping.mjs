import { client } from "./client.mjs";
try {
  const r = await client.messages.countTokens({
    model: "claude-haiku-5-5",
    messages: [{ role: "user", content: "Hello world, this is a test of the tokenizer." }],
  });
  console.log("count_tokens OK:", r.input_tokens);
} catch (e) {
  console.log("count_tokens failed:", e.status, e.error?.error?.type, e.error?.error?.message);
}
