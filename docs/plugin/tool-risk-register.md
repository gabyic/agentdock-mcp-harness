# Tool risk register

All 40 tools must expose explicit readOnlyHint, destructiveHint, and openWorldHint values.

| Tool | R | D | O | Justification |
| --- | --- | --- | --- | --- |
| repo.inspect | T | F | F | local Git read |
| task.create | F | F | F | creates isolated local worktree |
| task.evidence.record | F | F | F | appends durable PASS/FAIL evidence tied to current Task commit |
| task.list | T | F | F | reads durable Task/hygiene/storage status without cleanup |
| task.resume | T | F | F | reads durable task |
| task.finish | F | T | F | irreversibly finalizes task |
| task.cancel | F | T | F | terminates task lifecycle |
| task.cleanup | F | T | F | deletes finalized worktree |
| file.read | T | F | F | local file read |
| file.search | T | F | F | local search |
| file.patch | F | T | F | can overwrite file content |
| file.write | F | T | F | can replace file content |
| git.diff | T | F | F | reads local diff |
| git.commit | F | F | F | additive local commit; no push |
| audit.get | T | F | F | reads persisted audit |
| approval.get | T | F | F | reads approval |
| approval.respond | F | F | F | records decision only |
| process.start | F | T | T | arbitrary command may be irreversible and reach internet |
| process.status | T | F | F | reads process state |
| process.output | T | F | F | reads stdout/stderr |
| process.cancel | F | T | F | terminates process group |
| run.start | F | T | T | preferred async command execution surface |
| run.get | T | F | F | reads bounded durable/live Run status and output |
| run.cancel | F | T | F | requests cancellation of a locally owned Run |
| plan.start | F | T | T | starts durable deterministic command steps |
| plan.get | T | F | F | reads durable Plan progress and blockers |
| plan.cancel | F | T | F | requests durable Plan cancellation |
| plan.continue | F | F | F | explicitly releases a durable reasoning, human, or resolved approval barrier |
| skill.list | T | F | F | local skill metadata |
| skill.search | T | F | F | local skill search |
| skill.read | T | F | F | local skill read |
| skill.invoke | T | F | F | returns instructions; no server-side execution |
| skill.install | F | T | T | clones external Git and may replace skill source |
| skill.update | F | T | T | replaces skill source from external Git |
| workflow.start | F | T | F | may replace existing durable workflow |
| workflow.list | T | F | F | reads workflows |
| workflow.status | T | F | F | reads workflow |
| workflow.update | F | T | F | overwrites durable workflow fields |
| workflow.guide | T | F | F | reads state and computes recommendation |
| workflow.advance | F | T | F | persists potentially irreversible phase transition |
