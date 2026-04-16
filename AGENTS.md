# AGENTS Guide for responses-adapter

Scope: this file applies to the whole repository unless a deeper `AGENTS.md` overrides it.

## Purpose
Owns the OpenAI-compatible responses adapter service.

## Category
- `package/service`

## Ownership and Precedence
- Root workspace governance: `/home/guilherme/brainstorm/AGENTS.md`.
- Repository-local rules in this file apply within this repository scope.
- Deeper `AGENTS.md` files override this file for their subtree scope.

## Repository-Specific Rules
- Keep exported interfaces and compatibility notes explicit for downstream consumers.
- Avoid speculative rules not grounded in package scripts or runtime contracts.
- Keep README and AGENTS aligned with package/service boundaries.

## Commands and Validation
- `pnpm build`
- `pnpm check`

## What Not To Do
- Do not copy instructions from unrelated repositories without evidence in this repository.
- Do not claim ownership of sibling repositories or services not listed in this repository README.
- Do not commit secrets, local env files, or generated runtime artifacts.

## Related Repositories
- See `README.md` section `Related Repositories and Packages`.

## References
- README.md
- /home/guilherme/brainstorm/AGENTS.md
