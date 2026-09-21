# Install, Upgrade, Uninstall, and Release Artifacts

AgentDock v0.2 uses a managed user-local installation lifecycle.

## Install

From either a Git checkout or an extracted AgentDock release archive:

```bash
./scripts/install.sh
```

Default paths:

```text
program: ~/.local/share/agentdock-mcp-harness
CLI:     ~/.local/bin/agentdock
MCP:     ~/.local/bin/agentdock-mcp
state:   ~/.local/state/agentdock
```

The installer:

1. validates Node.js 24+ and npm;
2. optionally runs the source test suite;
3. installs production dependencies into a staging directory;
4. writes a managed-install manifest;
5. atomically swaps the installed program directory;
6. creates managed CLI launchers.

A Git repository is **not** required for installation. Extracted release tarballs are supported directly.

### Options

```text
--install-dir PATH
--bin-dir PATH
--state-dir PATH
--skip-tests
```

An explicit `--state-dir` remains an environment override in the generated launchers. Without it, runtime state follows the normal AgentDock configuration precedence.

## Managed-install manifest

Managed installs contain:

```text
<install-dir>/.agentdock-install.json
```

The manifest records non-secret installation metadata including:

- manifest schema version;
- AgentDock package/version;
- installation directory;
- launcher directory;
- state directory used at install time;
- whether state was an explicit install override;
- install/upgrade mode;
- installation timestamp.

Lifecycle mutation commands refuse to operate on an installation without a valid managed manifest.

## Upgrade

AgentDock does **not** automatically download or execute a newer version.

Obtain a trusted new checkout or extracted release first, then either run:

```bash
/path/to/new-agentdock/scripts/upgrade.sh
```

or, from a managed install:

```bash
agentdock upgrade --source /path/to/new-agentdock
```

Useful options:

```text
--skip-tests
--force
--allow-downgrade
```

The upgrade process:

1. reads the installed version from the managed manifest;
2. reads the target version from the supplied source;
3. performs deterministic SemVer comparison;
4. refuses downgrades unless explicitly allowed;
5. preserves state and configuration;
6. runs the normal atomic installer against the same managed install;
7. verifies that the installed manifest reports the expected target version.

If the target version equals the current version, upgrade is a no-op unless `--force` is supplied.

## Uninstall

From a managed installation:

```bash
agentdock uninstall
```

Default behavior is intentionally conservative:

```text
program files   removed
managed launchers removed
durable state   preserved
config file     preserved
```

### Remove state explicitly

```bash
agentdock uninstall --remove-state
```

To name the state path explicitly:

```bash
agentdock uninstall --remove-state --state-dir /path/to/state
```

State deletion is permanent. The uninstaller rejects dangerous targets such as `/`, the user's home directory, the launcher directory, and the AgentDock installation directory.

### Remove configuration explicitly

```bash
agentdock uninstall --remove-config
```

Specify another config file with:

```bash
agentdock uninstall --remove-config --config /path/to/config.json
```

State and config removal are independent.

## Unmanaged source deployments

Lifecycle mutation commands intentionally refuse an unmanaged source checkout:

```text
Managed AgentDock install manifest not found or invalid
```

This prevents `agentdock uninstall` from deleting a development checkout such as `/home/ubuntu/AgentDock`.

Source deployments can still use:

```bash
agentdock doctor
agentdock version
```

## Reproducible release artifacts

Build from a **clean Git checkout**:

```bash
npm run release:build
```

or:

```bash
./scripts/build-release.sh /path/to/output
```

Outputs:

```text
agentdock-mcp-harness-v<VERSION>.tar.gz
agentdock-mcp-harness-v<VERSION>.tar.gz.sha256
```

The builder:

- refuses a dirty worktree;
- archives the exact current Git commit;
- uses a versioned top-level directory;
- uses `gzip -n` so the gzip header contains no build-time timestamp;
- writes a SHA-256 checksum file.

For the same Git commit, repeated builds produce byte-identical `.tar.gz` files.

Verify:

```bash
sha256sum -c agentdock-mcp-harness-v<VERSION>.tar.gz.sha256
```

Then extract and install without Git metadata:

```bash
tar -xzf agentdock-mcp-harness-v<VERSION>.tar.gz
cd agentdock-mcp-harness-<VERSION>
./scripts/install.sh
```

## Security boundary

The lifecycle intentionally does not:

- download updates automatically;
- trust an unverified remote channel;
- modify systemd;
- expose AgentDock to the network;
- remove state/config during ordinary uninstall.

Remote service deployment and service lifecycle remain separate operational concerns.
