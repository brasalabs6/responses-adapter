# responses-adapter

Local adapter that exposes an OpenAI-like API so you can use Groq and MiniMax through a single endpoint.

## What it does

- `POST /v1/responses`
  - `groq/<model>`: forwards to `https://api.groq.com/openai/v1/responses` (including `previous_response_id`)
  - `minimax/<model>`: bridges to `https://api.minimax.io/v1/chat/completions`, normalizes to `responses`, and keeps local response history for incremental continuation with `previous_response_id`
- `POST /v1/chat/completions`
  - passthrough for `groq/<model>` and `minimax/<model>`
  - MiniMax requests default to `reasoning_split=true` unless explicitly set
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
- optional local history store: `ADAPTER_DATA_DIR`, `RESPONSES_HISTORY_FILE`
- optional output sanitization: `STRIP_THINK_TAGS` (`true` by default)
- optional monitoring: `LANGWATCH_API_KEY`, `LANGWATCH_ENDPOINT_URL`, `LANGWATCH_SERVICE_NAME`

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

## Health

`GET /health` returns adapter/provider status and LangWatch state:

- `langwatch.enabled`
- `langwatch.endpoint` (when enabled)
- `responses_store.path`

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

### MiniMax multi-turn via `previous_response_id`

```bash
FIRST=$(curl -sS http://localhost:19090/v1/responses \
  -H "Authorization: Bearer $ADAPTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "minimax/codex-MiniMax-M2.7",
    "input": "Remember this code: 9281"
  }')

RID=$(echo "$FIRST" | jq -r '.id')

curl -sS http://localhost:19090/v1/responses \
  -H "Authorization: Bearer $ADAPTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"minimax/codex-MiniMax-M2.7\",
    \"previous_response_id\": \"${RID}\",
    \"input\": \"What code did I give you?\"
  }"
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

For MiniMax, continuity by `previous_response_id` is implemented inside the adapter using a local append-only JSONL store. If a `previous_response_id` is unknown, the adapter returns `400 invalid_request_error`.

## Codex CLI compatibility

Latest test report: [docs/codex-compatibility-2026-04-14.md](./docs/codex-compatibility-2026-04-14.md)

Quick summary:

- MiniMax (`minimax/codex-MiniMax-M2.7`) works with tools, bash commands, and internet access via terminal.
- Groq via `/responses` works with `openai/gpt-oss-120b` and `moonshotai/kimi-k2-instruct`.
- `/v1/responses` now ensures `output_text` is filled when Groq returns only structured `output`.
- `/v1/chat/completions` defaults MiniMax to `reasoning_split=true`; very low `max_tokens` can still lead to empty/truncated assistant content.

## LangWatch Monitoring

When `LANGWATCH_API_KEY` is set, the adapter automatically sends traces to LangWatch.

- Default endpoint: `https://langwatch.brasaai.com.br`
- Data capture mode: input + output
- Coverage:
  - incoming request traces for `/v1/responses`, `/v1/responses/compact`, `/v1/chat/completions`
  - child spans for upstream Groq/MiniMax calls
  - bridge/conversion spans for MiniMax `chat/completions -> responses`
- thread-level output is mapped to final assistant text, with explicit fallback marker for empty assistant output
  - traces are grouped with `langwatch.thread.id` based on the response chain

If `LANGWATCH_API_KEY` is not set, monitoring is disabled and the adapter runs normally.

## Organization Context
- Organization: `brasalabs6`
- Repository: `brasalabs6/responses-adapter`
- Architecture category: `package/service`

## Role in BrasaLabs Architecture
Owns the OpenAI-compatible /responses adapter for provider interoperability.

## Related Repositories and Packages
- `brasalabs6/brainstorm` (consumer integrations)
- `brasalabs6/stack-codex-lb` (runtime ingress/deployment)
- `brasalabs6/specs` (governance/session memory)

## AGENTS Guidance
- Repository-local operational rules and contribution constraints are defined in `AGENTS.md`.
