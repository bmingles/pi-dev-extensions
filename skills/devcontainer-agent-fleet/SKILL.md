---
name: devcontainer-agent-fleet
description: Creating a Git worktree for a task, launching or delegating to a coding agent inside a devcontainer, picking a model for one, checking whether a started agent is actually ready (not just detected), driving a running agent's pane, or cleaning up a worktree/agent when finished. Covers both the host-side devcontainer_herdr_* tools and the container-side herdr_devc_* tools shipped by this package.
---

# Devcontainer agent fleet

This package ships **two different tool families**, for two different processes, that never
load together — `requireSide` guarantees only one family is ever present. Work out which one
you have before doing anything else:

- **`devcontainer_herdr_*`** (5 tools) — you are a **host**-side pi orchestrator, alongside a
  **host** Herdr, fanning agents out into a devcontainer. This is the common case and the rest
  of this skill is mostly about it.
- **`herdr_devc_*`** (2 tools: `herdr_devc_worktree_path`, `herdr_devc_worktree_create`) — you
  are running **inside** the devcontainer yourself, alongside a container-local `pi-herdr`.
  There is no start/list/one-call tool on this side — an in-container pi doesn't need to fan
  agents out into itself. See "Container side", below.

If neither family is registered, this package's devcontainer tools aren't active (no
resolvable `herdr` binary) — `/devcontainer` says why.

## Host side: the default workflow

**Default to isolating substantial new work in a worktree and handing it to an agent**, rather
than working in the main checkout yourself. A one-line fix, a question, or work the user is
clearly doing themselves does not need a worktree — this is a default, not a law.

The one-call path is `devcontainer_herdr_start_worktree_agent`: it creates the worktree and
starts the agent in it, reusing the pane the worktree's own workspace opened rather than
leaving it idle and splitting a second one. Use the two primitives
(`devcontainer_herdr_worktree_create` then `devcontainer_herdr_start_agent`, passing the
create result's `hostPath` and `openWorkspaceId` as `workspaceId`) only when you need to
inspect or adjust the worktree before an agent starts in it.

```
devcontainer_herdr_start_worktree_agent({ purpose: "fix the flaky retry test", model: "opus" })
```

**Do not send a work prompt when the user only asked for provisioning.** Creating a worktree
and starting an agent is one request; handing it a task is a different one — don't conflate
them.

### Branch naming

Pass `purpose` (a few words describing the task) rather than inventing a branch name — the
tool derives `agent/<slugified-purpose>` and always reports the final name back in the
result. Never assume it; read it from `branch` in the response.

- An explicit `branch` you pass collides with `PATH_EXISTS` and is never silently changed —
  use it when the name matters (e.g. the user specified one).
- A `purpose`-derived name that collides is disambiguated automatically with `-2`, `-3`, … up
  to `-9`, then fails with `DERIVED_BRANCH_EXHAUSTED` — a derived name exists so unattended
  work doesn't stop on a collision.

### Model selection

Pass `model` (e.g. `"opus"`, `"sonnet"`) structurally instead of hand-building a flag in
`agentArgs`. It is translated to the flag the agent kind's own CLI understands — currently
known for `claude`, `copilot` and `pi` (all three take `--model <value>`; see
`herdr-launch.ts`'s `modelFlagForAgentKind` for the exact, measured mapping and its
per-kind caveats — claude's value is a fixed alias, copilot's and pi's are closer to a
free-form model id/pattern).

- A kind with no known flag fails `MODEL_UNSUPPORTED` — put the flag directly in `agentArgs`
  instead of guessing one.
- An explicit `--model` already present in `agentArgs` always wins over `model`; the
  parameter is dropped, and the result text says so. Never pass both meaning to set two
  different models — most agent CLIs error on two `--model` flags.

### The Copilot folder-trust overlay

Copilot's first run in a fresh worktree shows an interactive "do you trust the files in this
folder" overlay. As of this writing there is **no CLI flag or env var that bypasses it**
(`--allow-all-tools`/`--allow-all`/`--yolo` govern *tool* permissions, a separate system from
folder trust — measured against `copilot --help`, `copilot help permissions` and
`copilot help config`; `trustedFolders` exists but only as a config-file setting, not a
launch flag, so it isn't wired here). Clear it by hand:

- Use `herdr_send_keys` with arrow keys (to move the selection) and Enter to confirm.
- **Do not use `herdr_send_prompt`** — it types text, and a multi-choice overlay does not
  read typed text as a selection. This is the mistake to avoid.
- Confirm the exact key sequence against the live pane (`herdr_read_agent`) before sending —
  the overlay's default selection may not always be "yes, trust this folder".

### `detected` is not `ready`

`devcontainer_herdr_start_agent` (and the one-call tool) return `startupState`:

- `"detected"` — Herdr's own poll matched a process rule. This is the default, cheap
  signal, and it does **not** mean the agent finished initializing or is accepting input.
- `"ready"` / `"unknown"` — only meaningful when you pass `waitForReady: true`. No agent kind
  currently has a measured "ready" pane pattern (this needs a live host + built devcontainer
  to capture), so as of this writing `waitForReady` always resolves to `"unknown"` — treat
  that exactly like `"detected"`.

**Read the pane (`herdr_read_agent`) before reporting success to a human.** `working` and
`blocked` are Herdr's own trustworthy screen-detection states; `idle` is a fallback that also
covers "not started yet", "failed to launch" and "stuck on an auth prompt" — don't treat
`idle` as success.

### Driving and cleaning up

Once an agent is running (a `paneId` in hand), everything else is `pi-herdr`'s own tools,
unrelated to this package:

- `herdr_send_prompt` — send it a task.
- `herdr_wait_agent` — wait for `working`/`blocked`/etc.
- `herdr_read_agent` — read the pane's screen, e.g. to check the trust overlay or confirm the
  right model came up.
- `herdr_send_keys` — for anything that isn't plain text (the trust overlay above; also note
  `shift+tab` does not survive `docker exec -it`, so pass `--permission-mode` in `agentArgs`
  up front instead of relying on the chord).
- `herdr_worktree_remove` — removes the worktree. When the agent's pane came from the
  create-then-attach path (i.e. you passed `workspaceId`/used the one-call tool), this closes
  the agent's pane too, since it's tied to the same Herdr workspace. A pane split off
  separately (no `workspaceId`) is not connected to the worktree and is not closed by this.

Use `devcontainer_herdr_worktree_list` to check on a repo's worktrees — it reports both
`hostPath` and `containerPath` (`null` when not container-visible) per worktree, unlike
`pi-herdr`'s own `herdr_worktree_list`, which only ever reports host paths and additionally
rejects passing `workspaceId` and `cwd` together despite its schema suggesting both work (an
upstream bug, not this package's). `containerVisible: false` means no container agent can be
started in that worktree — the fix is a `.devc/devc.jsonc` mount and a rebuild, not a retry.

## Container side

If you have `herdr_devc_worktree_path` / `herdr_devc_worktree_create` instead, you're running
*inside* the devcontainer already, alongside a container-local Herdr. There's no
start/list/one-call tool here — launching more agents from inside a container agent isn't
this package's job. Use `herdr_devc_worktree_path` to resolve a worktree's path under the
`<repo>.worktrees/<slug>` convention (guarded against an unmounted `.worktrees` directory,
`NOT_A_MOUNT`) and `herdr_devc_worktree_create` to actually create one, then drive it with
`pi-herdr`'s own tools exactly as above.
