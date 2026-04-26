# AGENTS Guide for responses-adapter

Scope: this file applies to the whole repository unless a deeper `AGENTS.md` overrides it.

## Requirement Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `NOT RECOMMENDED`, `MAY`, and `OPTIONAL` in this document are to be interpreted as described in BCP 14, RFC 2119, and RFC 8174 when, and only when, they appear in all capitals.

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
- Run package/service build and verification commands relevant to changed docs/instructions.
- Avoid speculative rules not grounded in repository scripts or runtime contracts.

## Commands and Validation
- `pnpm build`
- `pnpm check`

## Failure Modes
- BLOCK if required commands/scripts referenced by this file are missing or failing.
- BLOCK if organization naming or repository ownership statements diverge from README and root governance.
- BLOCK if changes would reassign ownership boundaries to sibling repositories.

## What Not To Do
- MUST NOT copy instructions from unrelated repositories without evidence in this repository.
- MUST NOT claim ownership of sibling repositories or services not listed in this repository README.
- MUST NOT commit secrets, local env files, or generated runtime artifacts.

## Related Repositories
- See `README.md` section `Related Repositories and Packages`.

## References
- README.md
- /home/guilherme/brainstorm/AGENTS.md
