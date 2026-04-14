# Codex Compatibility Report (2026-04-14)

Date: 2026-04-14
Environment: Codex CLI `0.120.0`
Adapter: local `responses-adapter` on `http://127.0.0.1:19090`

## Scope

Validation covered:

- OpenAI-like endpoints: `/v1/responses`, `/v1/responses/compact`, `/v1/chat/completions`, `/health`
- MiniMax response chain (`previous_response_id`) including error path
- Groq + MiniMax non-stream and stream behavior
- LangWatch trace registration and output capture
- Codex CLI tool/bash/internet behavior through the adapter

## Tested Models

- MiniMax:
  - `minimax/codex-MiniMax-M2.7`
- Groq:
  - `groq/openai/gpt-oss-120b`
  - `groq/moonshotai/kimi-k2-instruct`

## API Validation Results

- `GET /health`: PASS
- MiniMax `/v1/responses` non-stream: PASS
- MiniMax `/v1/responses` stream: PASS
- MiniMax `/v1/responses` chain with `previous_response_id`: PASS
- MiniMax invalid `previous_response_id` returns `400 invalid_request_error`: PASS
- Groq `/v1/responses` non-stream: PASS
- Groq `/v1/responses` stream: PASS
- Groq `/v1/responses/compact`: PASS
- MiniMax `/v1/chat/completions`: PASS (with caveat below)
- Groq `/v1/chat/completions`: PASS

## Adapter Behavior Notes

- MiniMax chat paths now default to `reasoning_split=true` (unless caller explicitly sends `reasoning_split`).
- For Groq `/v1/responses`, adapter now derives/fills `output_text` when upstream returns only structured `output` blocks.
- Think-tag stripping remains enabled by default (`STRIP_THINK_TAGS=true`) for response normalization.

### MiniMax caveat

With very small `max_tokens`, MiniMax may still return empty or truncated `message.content` even with `reasoning_split=true` because token budget can be consumed by reasoning. This was observed in repeated low-budget chat-completions calls.

## LangWatch Validation

Configured endpoint: `https://langwatch.brasaai.com.br`

Validated:

- New traces created for all tested endpoints.
- `/v1/responses` traces include non-empty output text for successful completions.
- `langwatch.thread.id` is set for response-chain traces.
- Empty assistant cases are now explicitly marked in trace output (`[empty assistant output]`) at trace detail level.

Observed platform behavior:

- In list/search digests, some traces may still appear as `Output: N/A` even when `get_trace` shows explicit output data. Trace detail view is authoritative.

## Codex CLI Validation

### MiniMax (`minimax/codex-MiniMax-M2.7`)

- Tool call + shell execution: PASS
- Internet via shell (`curl`): PASS
- File write/read roundtrip via tools: PASS

### Groq `gpt-oss-120b`

- Tool call + shell execution: PASS
- Internet via shell (`curl`): PASS
- File write/read roundtrip via tools: PASS

### Groq `kimi-k2-instruct`

- Tool call + shell execution: PASS
- Internet via shell (`curl`): PASS
- File write/read roundtrip via tools: PASS

## Artifacts Used During Validation

- `/tmp/codex-minimax-live`
- `/tmp/codex-groq-oss-live`
- `/tmp/codex-groq-kimi-live`
- `/tmp/codex-retest-minimax`
- `/tmp/codex-retest-groq-oss`
- `/tmp/codex-retest-groq-kimi`

