// Shared Anthropic client for benchmarks. Reads key + workspace from ../.env.
import "./env.mjs";
import Anthropic from "@anthropic-ai/sdk";
export const client = new Anthropic({
  defaultHeaders: process.env.ANTHROPIC_WORKSPACE_ID
    ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID }
    : undefined,
});
