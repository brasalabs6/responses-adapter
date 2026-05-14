import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGroqPayloadFromResponses,
  buildMiniMaxPayloadFromResponses,
  buildProviderHealth,
  createGroqProvider,
  createMiniMaxProvider,
  resolveProvider,
} from "../src/providers/index.js";

const providers = [
  createGroqProvider({ apiKey: "groq-key", baseUrl: "https://groq.test/openai/v1" }),
  createMiniMaxProvider({ apiKey: "minimax-key", baseUrl: "https://minimax.test/v1" }),
];

test("resolveProvider routes models by registered provider prefix", () => {
  const groq = resolveProvider("groq/openai/gpt-oss-120b", providers);
  assert.equal(groq.provider.id, "groq");
  assert.equal(groq.upstreamModel, "openai/gpt-oss-120b");

  const minimax = resolveProvider("MiniMax/codex-MiniMax-M2.7", providers);
  assert.equal(minimax.provider.id, "minimax");
  assert.equal(minimax.upstreamModel, "codex-MiniMax-M2.7");
});

test("resolveProvider reports supported prefixes for unknown providers", () => {
  assert.throws(
    () => resolveProvider("unknown/model", providers),
    /unsupported provider prefix\. Use groq\/<model> or minimax\/<model>/,
  );
});

test("buildProviderHealth keeps legacy configured fields and exposes generic provider metadata", () => {
  assert.deepEqual(buildProviderHealth(providers), {
    groq_configured: true,
    minimax_configured: true,
    available: [
      { id: "groq", prefixes: ["groq"], configured: true },
      { id: "minimax", prefixes: ["minimax"], configured: true },
    ],
  });
});

test("buildGroqPayloadFromResponses keeps only Groq-supported response fields", () => {
  const payload = buildGroqPayloadFromResponses(
    {
      input: "say ok",
      instructions: "be brief",
      previous_response_id: "ignored",
      store: true,
      stream: false,
      max_tokens: 42,
      tools: [
        { type: "function", name: "lookup" },
        { type: "web_search_preview" },
      ],
      tool_choice: "auto",
      unsupported: "drop me",
    },
    "openai/gpt-oss-120b",
    "resp_prev",
  );

  assert.deepEqual(payload, {
    model: "openai/gpt-oss-120b",
    input: "say ok",
    instructions: "be brief",
    previous_response_id: "resp_prev",
    store: true,
    stream: false,
    max_output_tokens: 42,
    tools: [{ type: "function", name: "lookup" }],
    tool_choice: "auto",
  });
});

test("buildMiniMaxPayloadFromResponses bridges responses input to chat completions", () => {
  const payload = buildMiniMaxPayloadFromResponses(
    {
      input: "say ok",
      instructions: "system note",
      max_output_tokens: 24,
      reasoning_split: false,
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Find data",
          parameters: { type: "object" },
        },
      ],
      tool_choice: { type: "function", name: "lookup" },
    },
    "codex-MiniMax-M2.7",
    false,
  );

  assert.deepEqual(payload, {
    model: "codex-MiniMax-M2.7",
    messages: [
      { role: "system", content: "system note" },
      { role: "user", content: "say ok" },
    ],
    stream: false,
    max_tokens: 24,
    reasoning_split: false,
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Find data",
          parameters: { type: "object" },
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: {
        name: "lookup",
      },
    },
  });
});

test("buildMiniMaxPayloadFromResponses defaults reasoning_split when omitted", () => {
  const payload = buildMiniMaxPayloadFromResponses(
    { input: "say ok" },
    "codex-MiniMax-M2.7",
    true,
    [{ role: "user", content: "from history" }],
  );

  assert.equal(payload.reasoning_split, true);
  assert.deepEqual(payload.messages, [{ role: "user", content: "from history" }]);
});
