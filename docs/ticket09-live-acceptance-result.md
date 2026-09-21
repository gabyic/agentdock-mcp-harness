# AgentDock v0.1 Live Product Acceptance Result

Status: PASS
Completed: 2026-09-21

## Product surface

- Client: real ChatGPT Web conversation
- MCP app: AgentDock
- Public MCP URL: https://agentdock.43.135.129.110.sslip.io/mcp
- Backend host: current Leapscall Linux server
- AgentDock service: agentdock-mcp.service
- Acceptance source repo: /home/ubuntu/agentdock-acceptance-v01

## Formal Task

- task_id: task_21243698-b247-48bf-9e6e-7da58dd699f4
- source base HEAD: 8af70addc4510e172651567d428a30525ba6ddeb
- Task commit: 74ffdc468da7fa7c5d447b12261fa828d6c5366e
- final status: COMPLETED
- source repo final HEAD: 8af70addc4510e172651567d428a30525ba6ddeb
- source zero-pollution: PASS

## Acceptance path

1. ChatGPT Web connected to the real AgentDock MCP app using OAuth.
2. repo.inspect confirmed the independent source repo was clean.
3. task.create created an isolated durable worktree.
4. file.search and file.read located the intentionally broken pricing implementation.
5. First patch fixed subtotal accumulator 1 -> 0.
6. Real targeted test returned exit_code=1.
7. Failure output showed '$5.0' !== '$5.00'.
8. Second patch changed toFixed(1) -> toFixed(2), directly driven by the failure.
9. A real MCP interruption was created by terminating the AgentDock OAuth proxy.
10. Initial task.resume calls failed because the connector was genuinely unavailable.
11. Leapscall SSH was used only to diagnose and repair the AgentDock platform service, not to inspect/edit/test/commit the formal Task.
12. Root cause: systemd Restart=on-failure did not restart after intentional SIGTERM because the exit was considered successful.
13. Service policy was corrected to Restart=always.
14. A controlled SIGTERM verified automatic restart: MainPID changed and NRestarts incremented.
15. ChatGPT Web then successfully resumed the same task_id through AgentDock MCP.
16. The interrupted restart process was restored as INTERRUPTED, never falsely RUNNING.
17. The second code edit was confirmed durable after restart.
18. Smart Approval emitted APPROVAL_REQUIRED for a harmless printf operation.
19. Current ChatGPT approved it with ALLOW_ONCE.
20. Targeted test passed with exit_code=0.
21. Full suite passed: 2 tests, 2 pass, 0 fail.
22. git.diff showed exactly the two intended pricing changes.
23. git.commit created real commit 74ffdc468da7fa7c5d447b12261fa828d6c5366e.
24. task.finish explicitly marked the Task COMPLETED.
25. audit.get contained Task, file, process, interruption, approval, commit, and finish evidence.
26. External post-finish verification confirmed source repo HEAD and working tree were unchanged.

## Zero second-LLM evidence

The deployed AgentDock service has no AI provider environment variables and Core runtime dependencies remain deterministic MCP/Zod code only. No server-side LLM or extra AI API key participated in the formal Task.

## SSH boundary

The formal Task's engineering actions after task.create were performed through AgentDock MCP. Leapscall SSH was used only for AgentDock infrastructure diagnosis/recovery after the intentionally induced service interruption and for post-finish external source-repo verification. It was not used to read, modify, test, diff, or commit the acceptance Task.

## Operational fix discovered by live acceptance

The live restart test exposed one platform issue that the automated stdio acceptance could not reveal:

- bad: Restart=on-failure
- reason: intentional SIGTERM exits cleanly, so systemd does not restart the service
- fixed: Restart=always
- verified: controlled SIGTERM caused automatic restart, new MainPID, healthy port 3400, healthy public OAuth endpoint

This is now part of the deployed service behavior.

## Verdict

AgentDock v0.1 Core product hypothesis is proven on the real target topology:

ChatGPT Web -> OAuth/HTTPS MCP -> AgentDock -> Linux Git/files/process/OS

with no second reasoning model on the server.
