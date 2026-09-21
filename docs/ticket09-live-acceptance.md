# AgentDock v0.1 Live Product Acceptance

Status: PASS
Prepared: 2026-09-21

## Live MCP endpoint

- MCP URL: https://agentdock.43.135.129.110.sslip.io/mcp
- OAuth issuer: https://agentdock.43.135.129.110.sslip.io/
- Service: agentdock-mcp.service
- Local listener: 127.0.0.1:3400
- Backend: /usr/bin/node /home/ubuntu/AgentDock/src/index.js
- Runtime state: /home/ubuntu/agentdock-runtime/state
- OAuth state: /home/ubuntu/agentdock-runtime/oauth

The endpoint uses the same password-auth configuration as the existing
mcp.leapscall.com connector, but has independent OAuth state and AgentDock state.

## Formal acceptance repository

- Source repo: /home/ubuntu/agentdock-acceptance-v01
- Baseline HEAD: 8af70addc4510e172651567d428a30525ba6ddeb
- Working tree must be clean before task.create.
- This repo contains an intentional two-part bug.

## Preflight passed

- AgentDock core automated acceptance: PASS (Ticket 08)
- HTTPS certificate/SNI: PASS
- OAuth discovery over public HTTPS: PASS
- Unauthenticated /mcp returns 401: PASS
- Existing mcp.leapscall.com remains healthy: PASS
- Existing whaleroute.leapscall.com remains healthy: PASS
- agentdock-mcp.service restart: PASS
- AgentDock service runs as ubuntu: PASS
- NoNewPrivileges: no
- AI provider environment variables in service: none
- AgentDock repo working tree: clean
- Acceptance source repo working tree: clean
- sudo -n as ubuntu: unavailable; this is not a Core PASS prerequisite

## ChatGPT Web connection

Create/enable the custom MCP app in ChatGPT using the live MCP URL above and
OAuth. Tool scan must expose AgentDock tools including:

- task.create / task.resume / task.finish
- file.read / file.search / file.patch / file.write
- process.start / process.status / process.output / process.cancel
- approval.get / approval.respond
- git.diff / git.commit
- audit.get

## Formal task rules

After the first task.create against the acceptance source repo:

1. Do not use Leapscall SSH to read, edit, test, commit, inspect, or repair the
   acceptance task.
2. All engineering actions must use AgentDock MCP.
3. ChatGPT Web is the only reasoning agent.
4. Do not use any server-side LLM/API key.
5. Observe a real targeted test failure.
6. Make the second edit only after inspecting that failure.
7. Perform a real MCP reconnect and task.resume.
8. Exercise the configured Smart Approval rule with a harmless shell operation
   beginning with: printf acceptance-approval
9. Pass targeted and full tests.
10. Inspect git.diff, create a real commit, capture commit SHA.
11. Explicitly task.finish.
12. Inspect audit.get.
13. Verify source repo zero-pollution through AgentDock-visible Task semantics;
    final external source-repo verification may be performed only after the
    formal Task is finished.

## Definition of Ticket 09 completion

Only mark Ticket 09 IMPLEMENTED after the real ChatGPT Web product acceptance
has passed end-to-end.
