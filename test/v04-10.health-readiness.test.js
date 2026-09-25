import assert from "node:assert/strict";
import test from "node:test";

import { isReadyHealthPayload } from "../src/health-service.js";

test("v0.4-10: health requires SQLite authority and a ready Supervisor", async () => {
  const base = {
    status: "ok",
    transport: "streamable-http",
    state_backend: "sqlite",
    supervisor: { ready: true },
  };

  assert.equal(isReadyHealthPayload(base), true);
  assert.equal(isReadyHealthPayload({ ...base, state_backend: "json" }), false);
  assert.equal(
    isReadyHealthPayload({ ...base, supervisor: { ready: false } }),
    false,
  );
  assert.equal(isReadyHealthPayload({ status: "ok", transport: "streamable-http" }), false);
});
