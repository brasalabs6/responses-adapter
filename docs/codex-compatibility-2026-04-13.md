# Codex Compatibility Report (2026-04-13)

Date: 2026-04-13
Environment: Codex CLI `0.120.0`
Adapter: local `responses-adapter` on `http://127.0.0.1:19090`

## Scope

Validation focused on:

- Tool calls (`exec_command`) from Codex through `/v1/responses`
- Bash execution
- Internet access through terminal commands (`curl`)
- Model behavior differences between MiniMax and Groq providers

## Tested Models

- MiniMax:
  - `minimax/codex-MiniMax-M2.7`
- Groq:
  - `groq/openai/gpt-oss-120b`
  - `groq/moonshotai/kimi-k2-instruct-0905`
  - `groq/moonshotai/kimi-k2-instruct`

## Results

### MiniMax (`minimax/codex-MiniMax-M2.7`)

- Basic completion: PASS
- Single tool call (`echo`, `pwd`): PASS
- Multiple tool calls in sequence: PASS
- File roundtrip via tool calls (write + read): PASS
- Internet via terminal (`curl`): PASS
- Restart smoke test (after adapter restart): PASS

Observed behavior:

- MiniMax responses frequently include `<think>...</think>` in assistant output.
- This did not break tool execution flow during tests.
- For strict machine-consumable output, post-processing may be needed to strip think blocks.

### Groq (`gpt-oss-120b`, `kimi-k2-instruct`, `kimi-k2-instruct-0905`)

- Basic completion: PASS
- Tool call with command execution: PASS
- Internet via terminal (`curl`): PASS when sandbox is unrestricted

Observed behavior:

- No `<think>` leakage observed in tested Groq outputs.
- Under `workspace-write` sandbox, terminal internet access can fail due to network restrictions.

## Important Notes

1. For Codex tests that rely on terminal internet access, use unrestricted sandbox:

```bash
codex exec --dangerously-bypass-approvals-and-sandbox ...
```

2. `-m` reliably overrides model selection for one-off runs. Example:

```bash
codex exec -p groq-adapter -m groq/openai/gpt-oss-120b "Responda apenas com OK."
```

3. If using MiniMax in strict-output workflows (e.g. exact JSON), consider stripping `<think>` blocks at the adapter boundary.

## Reference Test Artifacts

Generated artifacts used in validation:

- `/tmp/codex-test`
- `/tmp/codex-groq-check2`
- `/tmp/codex-groq-check3`
- `/tmp/codex-groq-check4`
