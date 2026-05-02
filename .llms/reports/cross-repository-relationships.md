---
title: "responses-adapter Cross Repository Relationships"
date: "2026-05-02"
slug: "cross-repository-relationships"
status: "relevant"
status_reason: "Report organizacional gerado para alinhar o repositorio responses-adapter com o portifolio BrasaLabs."
last_reviewed_at: "2026-05-02"
source_path_legacy: "n/a"
---

# Relacionamentos Com Outros Repos

## Familias Organizacionais

- familia suporte/tooling

## Repos Relacionados Inferidos

- `brasalabs`: relacao provavel por familia, dependencia, consumidor, infra compartilhada ou origem de extracao.
- `hub`: relacao provavel por familia, dependencia, consumidor, infra compartilhada ou origem de extracao.

## Dependencias De Pacote Detectadas

- `@opentelemetry/context-async-hooks`
- `@opentelemetry/sdk-node`
- `dotenv`
- `express`
- `langwatch`
- `@types/express`
- `@types/node`
- `tsx`
- `typescript`

## Contratos Que Devem Ser Mantidos Sincronizados

- Se este repo publica pacote, alinhar versoes, changelog e consumidores declarados nos repos relacionados.
- Se este repo e stack, alinhar dominos, secrets, networks, volumes, labels de runner e smoke tests com `stack-traefik`, `stack-monitoring`, `stack-gatus` e specs centrais quando aplicavel.
- Se este repo e template, garantir que consumidores nao dependam de exemplos locais como se fossem runtime de producao.
- Se este repo e worktree/clone de correcao, registrar claramente a relacao com o repo canonical upstream e nao promover divergencia como fonte de verdade.

## Mapa De Fluxo Organizacional

1. Contrato local define ownership deste repo.
2. Repos consumidores importam pacote, imagem, app, stack ou convencao.
3. Specs/governanca centrais registram decisoes duraveis quando a mudanca afeta mais de um repo.
4. CI/release valida que a alteracao nao quebrou consumidores conhecidos.

## Evidencias

- `README.md:1`
- `AGENTS.md:1`
- `package.json:1`
