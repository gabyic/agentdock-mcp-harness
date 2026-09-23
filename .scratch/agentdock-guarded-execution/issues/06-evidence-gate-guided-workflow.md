# 06: Gate Guided Workflow completion on durable evidence

**What to build:** Make IMPLEMENT and REVIEW phase completion depend on linked Task outcomes, commit evidence, and review evidence instead of model-issued phase events alone.

**Blocked by:** 02: Make Task completion durable and evidence-bearing; 04: Migrate durable state callers to the transactional seam

**Status:** ready-for-agent

- [ ] A Workflow can link multiple implementation Tasks.
- [ ] implementation_complete fails when required implementation units lack terminal COMMIT/NO_CHANGE evidence.
- [ ] review_passed fails when review evidence is missing, targets the wrong implementation result, or contains blocking findings.
- [ ] Valid NO_CHANGE implementation units can satisfy the gate only with a recorded reason/evidence.
- [ ] Existing phase-boundary/open-decision checks remain intact.
