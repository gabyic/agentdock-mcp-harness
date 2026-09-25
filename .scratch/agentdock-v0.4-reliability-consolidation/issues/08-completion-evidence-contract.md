# 08: Completion Evidence Contract

**What to build:** Require workflow/task completion claims to be backed by caller-defined durable verification evidence instead of equating a clean worktree with verified completion.

**Blocked by:** 04: Durable Completion and Git Retention; 07: Truthful Task Activity and Blockers

**Status:** done

- [x] A Completion Contract can declare targeted tests, full suite, static/diff checks, migration checks, provider checks, and review evidence as required.
- [x] Required evidence is durable and tied to the implementation result it validates.
- [x] A known failing required check cannot be presented as verified completion.
- [x] NO_CHANGE can satisfy a contract only when its required reason/evidence is present.
- [x] Existing Guided Workflow evidence-gate concepts are reused/adapted rather than duplicated.
