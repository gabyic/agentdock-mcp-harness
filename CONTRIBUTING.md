# Contributing

Thanks for contributing to AgentDock MCP Harness.

## Development requirements

- Linux
- Node.js 24+
- Git

Install dependencies and run the full suite:

```bash
npm ci
npm test
npm run acceptance:v0.1
```

## Engineering rules

1. Keep AgentDock deterministic. Do not add a server-side LLM dependency to Core.
2. Preserve MCP black-box tests as the primary acceptance seam.
3. Write-capable coding Tasks remain Git/worktree isolated.
4. Do not silently weaken host permission semantics or claim sandboxing that does not exist.
5. Do not introduce universal rollback claims for arbitrary host side effects.
6. Add focused tests for lifecycle, durability, approval and audit changes.
7. Keep public tool behavior structured and explicit; avoid hidden shell fallbacks for first-class primitives.
8. Avoid speculative cross-platform abstractions. Add an abstraction when a second real backend requires it.

## Pull requests

A pull request should include:

- the problem being solved;
- the intended behavior;
- tests covering the public MCP surface;
- any compatibility or migration impact;
- security implications when permissions, host access, policy or audit are involved.

Run `npm test` before opening a PR.

## Commit style

Use concise conventional-style messages where practical, for example:

```text
feat: add task listing
fix: preserve interrupted process metadata
docs: clarify remote deployment
test: cover stale approval grants
```
