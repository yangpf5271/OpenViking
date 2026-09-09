# OpenViking Memory Plugin for ZCode

This package provides a ZCode lifecycle adapter for OpenViking long-term memory. It reuses the shared `memory-plugin-shared` runtime — no memory logic is duplicated. Only a thin ZCode adapter is new.

> **Requires an OpenViking server with `viking://~` home-alias support.** Recall targets the
> caller's own context space through `viking://~/memories` and `viking://~/skills`; the uid-less
> `viking://user/memories` shorthand is rejected by newer servers.

## What it does

- **SessionStart** — injects user profile and preferences/entities into context.
- **UserPromptSubmit** — searches OpenViking for relevant memories and injects them.
- **PreToolUse** (`Read|Glob|Grep`) — denies direct access to `viking://` URIs, redirects to MCP tools.
- **Stop** — returns immediately, then captures incremental user/assistant turns and commits the OpenViking session in a detached worker.

ZCode does not support `PreCompact`/`SessionEnd`/`SubagentStart`/`SubagentStop`, so the commit-on-`Stop` strategy compensates for the absence of compact/end-of-session signals. The rollout file is the authoritative incremental transcript: stable host `turnId` values drive deduplication and allow a later Stop to recover missed turns. Hook stdin is only a fallback when the rollout file is unavailable.

> Invariant: hook groups must OMIT the matcher key rather than writing `"matcher": ""`. Strict parsers treat an empty string as invalid and may silently drop the entire configuration source.

## Install

Use the shared installer:

```bash
bash examples/memory-plugin-shared/install.sh --harness zcode
```

The installer detects ZCode via `~/.zcode/` or a `zcode` binary, merges hooks and MCP config into `~/.zcode/cli/config.json`, and writes OpenViking credentials to `~/.openviking/ovcli.conf`.

On Windows, run the installer from Git Bash. From a local checkout of this repository (`--source dev` is auto-detected there; `--yes` skips the prompts), ZCode Desktop gets its hooks and MCP server installed as native process entries with Windows paths, and every script lands under the fixed user directory `~/.openviking/agent-integrations/` — the checkout is only read during installation, so it can be moved or deleted afterwards. Re-run the same command to update:

```bash
bash examples/memory-plugin-shared/install.sh --harness zcode --source dev --yes
```

## Architecture

The plugin vendors the shared runtime into `scripts/shared/` via `sync.mjs`. The dispatcher (`zcode-hook.mjs`) branches on event name; three thin shim scripts set an environment variable and import the dispatcher, while the URI guard has its own entry point. Shared runtime modules provide recall, batching, pending queue, credential resolution, and MCP proxying; `zcode-capture.mjs` owns the ZCode-specific acknowledgement and cursor state transition.

See [DESIGN.md](./DESIGN.md) for verified ZCode extension-surface facts and decision provenance.

## Tests

```bash
node --test scripts/*.test.mjs
```
