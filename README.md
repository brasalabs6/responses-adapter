# responses-adapter

Local adapter that exposes an OpenAI-like API so you can use Groq and MiniMax through a single endpoint.

## What it does

- `POST /v1/responses`
  - `groq/<model>`: forwards to `https://api.groq.com/openai/v1/responses`
  - `minimax/<model>`: bridges to `https://api.minimax.io/v1/chat/completions` and normalizes output to the `responses` format
- `POST /v1/chat/completions`
  - passthrough for `groq/<model>` and `minimax/<model>`
- `GET /health`

## Requirements

- Node.js 20+
- pnpm

## Configuration

Copy `.env.example` to `.env` and set:

- `ADAPTER_API_KEY`
- `GROQ_API_KEY`
- `MINIMAX_API_KEY`
- optional: `PORT`, `GROQ_BASE_URL`, `MINIMAX_BASE_URL`

## Run

```bash
pnpm install
pnpm dev
```

Default server: `http://localhost:19090`.

## Auth

All `/v1/*` routes require:

```http
Authorization: Bearer <ADAPTER_API_KEY>
```

## Examples

### Groq via /responses

```bash
curl -sS http://localhost:19090/v1/responses \
  -H "Authorization: Bearer $ADAPTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "groq/llama-3.1-8b-instant",
    "input": "Say only OK",
    "max_output_tokens": 20
  }'
```

### MiniMax via /responses (chat bridge)

```bash
curl -sS http://localhost:19090/v1/responses \
  -H "Authorization: Bearer $ADAPTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "minimax/codex-MiniMax-M2.7",
    "input": "Say only OK",
    "max_output_tokens": 20
  }'
```

### MiniMax via /chat/completions

```bash
curl -sS http://localhost:19090/v1/chat/completions \
  -H "Authorization: Bearer $ADAPTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "minimax/codex-MiniMax-M2.7",
    "messages": [{"role":"user","content":"Say only OK"}],
    "max_tokens": 20
  }'
```

## Note

MiniMax does not currently provide `/v1/responses` directly. This adapter keeps compatibility by bridging requests to chat completions and converting responses back to the OpenAI Responses shape.

## Codex CLI compatibility

Test report: [docs/codex-compatibility-2026-04-13.md](./docs/codex-compatibility-2026-04-13.md)

Quick summary:

- MiniMax (`minimax/codex-MiniMax-M2.7`) works with tools, bash commands, and internet access via terminal.
- Groq via `/responses` works with `openai/gpt-oss-120b` and `moonshotai/kimi-k2-instruct(-0905)`.
- MiniMax outputs often include `<think>...</think>` blocks.
