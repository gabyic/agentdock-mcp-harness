# 03: Idempotent Mutating Operations

**What to build:** Make mutating execution requests safely retryable after transport interruption by returning the original durable operation/Run instead of repeating side effects.

**Blocked by:** 02: Authoritative Task State Cutover

**Status:** ready-for-agent

- [ ] Run start accepts a durable operation/idempotency key.
- [ ] Retrying the same key with the same request fingerprint returns the original Run/result.
- [ ] Retrying the same key with a different request fingerprint is rejected.
- [ ] In-flight and terminal retries are both deduplicated across runtime restarts.
- [ ] The reproduced duplicate-side-effect test executes the side effect exactly once.
- [ ] Idempotency records are transactional and bounded by a documented retention policy.
