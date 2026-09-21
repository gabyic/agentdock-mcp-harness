# Security Policy

## Supported versions

The project is currently pre-1.0. Security fixes are applied to the latest release line.

## Reporting a vulnerability

Do not publish credentials, private host paths, authentication secrets, exploit payloads against a live deployment, or other sensitive details in a public issue.

Until a dedicated security contact is published, open a GitHub issue containing only a minimal non-sensitive description and request a private reporting channel.

## Execution model

AgentDock is intentionally capable of executing commands and accessing host files.

- Relative Task file paths are worktree-scoped.
- Explicit absolute paths access the host according to native OS permissions.
- Process execution inherits the AgentDock OS user's capabilities.
- AgentDock does not claim that arbitrary host effects are transactionally reversible.
- Public exposure requires authentication and TLS outside or in front of Core.

## Secrets

Persisted audit applies best-effort redaction for common token/password/credential patterns. Redaction is not a substitute for least privilege.

Live MCP responses preserve OS-authorized content. Treat MCP client access as privileged access to the AgentDock user account.

## Deployment guidance

- run AgentDock as a dedicated, minimally privileged OS user when practical;
- use authenticated HTTPS for remote MCP;
- keep the state directory private to the AgentDock user;
- protect OAuth and reverse-proxy configuration separately from the repository;
- review policy rules before enabling remote command execution;
- keep Node.js, Git, the MCP SDK, and the authentication layer patched.
