#!/usr/bin/env node
process.env.AGENTDOCK_TRANSPORT = "http";
await import("./index.js");
