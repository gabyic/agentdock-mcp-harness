# AgentDock Doctor

`agentdock doctor` performs deterministic environment diagnostics for an AgentDock installation.

It does not call an LLM, change project repositories, modify system services, edit sudoers, or repair configuration automatically.

## Usage

```bash
agentdock doctor
```

Machine-readable output:

```bash
agentdock doctor --json
```

Diagnose an explicit configuration file:

```bash
agentdock doctor --config /etc/agentdock/config.json
```

## Exit codes

- `0`: no FAIL checks. PASS and WARN are both operationally usable.
- `1`: one or more FAIL checks.
- `2`: CLI usage error.

Optional capabilities such as passwordless sudo produce WARN rather than FAIL.

## Checks

### Node.js

Reports the active Node.js runtime and executable.

AgentDock currently requires Node.js 24+.

### Git

Verifies that `git --version` succeeds.

### Git worktree capability

Creates a disposable repository under the OS temporary directory, creates and lists a detached worktree, removes it, and deletes the temporary repository.

No user project repository is modified.

### OS user

Reports:

- username;
- uid;
- gid;
- home directory.

This is important because AgentDock intentionally inherits the permissions of its OS user.

### sudo

Runs:

```text
sudo -n true
```

This never prompts for a password.

Results:

- PASS: passwordless sudo is available;
- WARN: sudo is absent or passwordless sudo is unavailable.

Sudo is optional and is not a Core requirement.

### Configuration

Runs the same canonical configuration loader used by AgentDock itself.

It reports only safe metadata:

- schema version;
- config path;
- whether the file was loaded;
- names of active `AGENTDOCK_*` overrides;
- state directory;
- transport mode;
- policy rule count.

It never prints policy rule bodies or environment values.

### State directory

Creates the configured state directory if necessary, writes and fsyncs a temporary probe file, then removes it.

This confirms that the AgentDock OS user can actually persist durable state.

### Transport

For stdio, Doctor reports the configured mode.

For HTTP it reports:

- bind host;
- port;
- MCP path;
- health path;
- allowed hosts;
- allowed origins.

A non-loopback HTTP bind produces WARN because authenticated TLS ingress is recommended even when AgentDock's Host/Origin guards are valid.

### Policy

Valid policy with at least one explicit rule produces PASS.

An empty policy is valid but produces WARN because unmatched operations use AgentDock's default allow behavior.

## Security and secrets

Doctor is intentionally designed not to echo credential values.

It does not print:

- environment variable values;
- policy rule bodies;
- OAuth credentials;
- API keys;
- passwords;
- tokens.

Configuration validation errors report schema paths/messages rather than raw input documents.

Use normal secret-management practices anyway; Doctor redaction is not a replacement for least privilege.

## Example

```text
AgentDock Doctor 0.2.0-rc.1
Overall: WARN

[PASS] node — Node.js v24.16.0
[PASS] git — git version 2.x.x
[PASS] git_worktree — Git detached worktree create/list/remove succeeded.
[PASS] os_user — Running as OS user ubuntu.
[WARN] sudo — Passwordless sudo is unavailable; Core does not require it.
[PASS] config — Configuration validated using defaults/environment; no config file was loaded.
[PASS] state_directory — State directory is writable.
[PASS] transport — Transport is stdio.
[PASS] policy — Policy configuration is valid.
```
