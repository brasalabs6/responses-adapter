# responses-adapter

Adapter local que expõe API OpenAI-like para usar Groq e MiniMax em endpoint unificado.

## O que ele faz

- `POST /v1/responses`
  - `groq/<model>`: encaminha para `https://api.groq.com/openai/v1/responses`
  - `minimax/<model>`: converte para `https://api.minimax.io/v1/chat/completions` e normaliza resposta para formato `responses`
- `POST /v1/chat/completions`
  - `groq/<model>` e `minimax/<model>` em passthrough
- `GET /health`

## Pré-requisitos

- Node.js 20+
- pnpm

## Configuração

Copie `.env.example` para `.env` e ajuste:

- `ADAPTER_API_KEY`
- `GROQ_API_KEY`
- `MINIMAX_API_KEY`
- opcionais: `PORT`, `GROQ_BASE_URL`, `MINIMAX_BASE_URL`

## Rodar

```bash
pnpm install
pnpm dev
```

Servidor padrão: `http://localhost:19090`.

## Auth

Todas as rotas `/v1/*` exigem:

```http
Authorization: Bearer <ADAPTER_API_KEY>
```

## Exemplos

### Groq via /responses

```bash
curl -sS http://localhost:19090/v1/responses \
  -H "Authorization: Bearer $ADAPTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "groq/llama-3.1-8b-instant",
    "input": "Diga apenas OK",
    "max_output_tokens": 20
  }'
```

### MiniMax via /responses (bridge para chat)

```bash
curl -sS http://localhost:19090/v1/responses \
  -H "Authorization: Bearer $ADAPTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "minimax/codex-MiniMax-M2.7",
    "input": "Diga apenas OK",
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
    "messages": [{"role":"user","content":"Diga apenas OK"}],
    "max_tokens": 20
  }'
```

## Observação

No cenário atual, MiniMax não expõe `/v1/responses` diretamente. O adapter implementa a ponte para manter contrato compatível com `/v1/responses`.

## Compatibilidade Codex CLI

Relatório de testes: [docs/codex-compatibility-2026-04-13.md](./docs/codex-compatibility-2026-04-13.md)

Resumo rápido:

- MiniMax (`minimax/codex-MiniMax-M2.7`) funciona com tools, bash e internet via terminal.
- Groq via `/responses` funciona com `openai/gpt-oss-120b` e `moonshotai/kimi-k2-instruct(-0905)`.
- Em MiniMax, a saída frequentemente inclui blocos `<think>...</think>`.
