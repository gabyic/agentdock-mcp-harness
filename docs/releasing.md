# Release Engineering

This document defines the AgentDock v0.2 release process.

## Principles

- A release is cut only from a clean committed Git HEAD.
- The Git tag, package version, lockfile version, runtime version constant, CHANGELOG entry and release notes must agree.
- The GitHub Release asset is rebuilt from the tagged commit; local artifacts are not trusted as the publication source.
- Release archives must be reproducible for the same commit.
- npm publication remains disabled unless explicitly approved in a future release decision.
- Release candidates accept blocker fixes only; new features wait for a later development line.

## Unified gate

Run:

```bash
npm run release:gate -- v0.2.0-rc.1
```

The gate requires a clean worktree and performs:

1. release metadata/version/tag validation;
2. `npm ci`;
3. full black-box tests;
4. v0.1 acceptance;
5. production dependency audit;
6. systemd contract validation;
7. release artifact build and checksum verification;
8. a second build and SHA-256 reproducibility comparison;
9. extracted archive installation;
10. installed `agentdock version` and `agentdock doctor`;
11. installed systemd-unit validation;
12. native HTTP start, health and graceful SIGTERM smoke;
13. npm pack metadata dry-run without publishing.

A passing gate ends with:

```text
RELEASE_GATE=PASS
```

## Preparing a release candidate

Example for `v0.2.0-rc.1`.

### 1. Freeze features

Do not add new product functionality after the RC freeze.

Only release blockers should cause another RC commit.

### 2. Set the SemVer version

Use:

```bash
npm version 0.2.0-rc.1 --no-git-tag-version
```

Keep `src/version.js` identical to the package version.

### 3. Cut the CHANGELOG section

Keep an empty:

```text
## [Unreleased]
```

and add a dated section such as:

```text
## [0.2.0-rc.1] - 2026-09-22
```

### 4. Add tag-specific release notes

Required path:

```text
docs/releases/v0.2.0-rc.1.md
```

The release verifier rejects a tag that has no matching release-notes file.

### 5. Commit and run the gate

The full release gate requires a clean worktree, so commit the RC preparation first.

Then:

```bash
npm run release:gate -- v0.2.0-rc.1
```

### 6. Push main and require CI success

```bash
git push origin main
```

Do not tag a commit whose main-branch CI is red.

### 7. Create an annotated tag

```bash
git tag -a v0.2.0-rc.1 -m "AgentDock MCP Harness v0.2.0-rc.1"
git push origin v0.2.0-rc.1
```

The tag triggers `.github/workflows/release.yml`.

## Tag workflow

The release workflow:

1. checks out the exact tag with full history;
2. runs the complete release gate again with the actual tag name;
3. determines prerelease status from SemVer;
4. requires `docs/releases/<tag>.md`;
5. publishes/replaces the generated `.tar.gz` and `.sha256` assets;
6. creates a GitHub prerelease when the SemVer contains a prerelease component.

The workflow has `contents: write` only because it must create/update GitHub Releases.

It does not publish to npm.

## Verify the published RC

After the tag workflow succeeds:

```bash
gh release view v0.2.0-rc.1
```

Download the assets and verify:

```bash
sha256sum -c agentdock-mcp-harness-v0.2.0-rc.1.tar.gz.sha256
```

Then perform at least one extracted-install smoke on Linux.

For production RC validation, also verify:

```bash
agentdock version
agentdock doctor
agentdock health
```

and the service restart/crash contract documented in `service-lifecycle.md`.

## RC blocker policy

If a blocker is found:

1. fix only the blocker and its regression test;
2. add the change under `[Unreleased]`;
3. bump to the next RC (for example `0.2.0-rc.2`);
4. cut a dated CHANGELOG section;
5. add matching release notes;
6. rerun the complete release process.

Do not move an existing tag.

## Promote to stable v0.2.0

Promotion requires:

- no unresolved release blocker;
- green main CI;
- green release gate;
- RC archive installation re-verified;
- production health/restart smoke green;
- stable `0.2.0` CHANGELOG section and `docs/releases/v0.2.0.md`.

Then bump version to `0.2.0`, commit, run the gate using `v0.2.0`, push main, and push the annotated `v0.2.0` tag.

The tag workflow will create a non-prerelease GitHub Release and mark it latest.

## Rollback

Git tags and published release assets are immutable release evidence and should not be rewritten.

If an RC is bad:

- leave its tag/release intact;
- document the blocker;
- cut a new RC.

Runtime rollback should use an earlier trusted release archive / managed upgrade with explicit `--allow-downgrade` only when the operator intentionally chooses that rollback.
