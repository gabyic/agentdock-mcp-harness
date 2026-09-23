# AgentDock v0.4 Roadmap

v0.4 is the distribution and ChatGPT-native integration line.

## P0 Directory readiness
- [x] Preserve maintenance/v0.3 before v0.4 development.
- [x] Keep the MCP surface explicit and reviewable; Guarded Execution adds read-only task.list, bringing the surface to 32 tools.
- [x] Add a canonical risk profile for every tool.
- [x] Emit explicit readOnlyHint, destructiveHint, and openWorldHint booleans for every tool.
- [x] Fail closed when a future tool lacks a risk profile.
- [x] Prepare tool-risk justifications.
- [x] Prepare five positive and three negative directory evaluation cases.
- [x] Create the v0.4 Wayfinder map.
- [ ] Decide Universal relay/control-plane vs OpenAI-approved Template/self-hosted endpoint.
- [ ] Provision a publisher-controlled production hostname.
- [ ] Finalize reviewer authentication/demo credentials.
- [ ] Publish final privacy, terms, support, and website URLs.
- [ ] Complete public directory submission and live acceptance.

## Constraints
- No second server-side LLM.
- No hidden autonomous loop.
- No replacement of Task/worktree/process/audit core.
- No SaaS/billing/RBAC expansion before topology is decided.
- Do not weaken approval or OS-permission boundaries.
