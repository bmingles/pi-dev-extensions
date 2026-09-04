# pi devcontainer extension

A [pi](https://github.com/earendil-works) coding-agent extension that runs `pi`
on the **host** and routes its built-in filesystem/shell tools into a
**devcontainer**. The container's lifecycle is driven **in-process** through
[`@devc-tools/core`](https://github.com/bmingles/devc-tools/tree/main/devc-core)
— devc's own start/mounts logic as an npm library — and the routed commands run
via `docker exec`. There is no `devc` binary *required* (see Requirements
below) — the seven routed built-ins never use one. The `devcontainer_herdr_*`
tools below are the one exception: when a `devc` binary *is* resolvable on
`PATH`, `devcontainer_herdr_start_agent` uses it automatically for a covered
agent kind (see its own section).

It is the same shape as pi's bundled
[`gondolin`](https://github.com/earendil-works/gondolin) example (which routes
into a micro-VM), but the isolation boundary here is a long-lived devcontainer
of the kind `devc` manages.

**Side: host.** Loaded on a container side (`/.dockerenv` present),
`requireSide` (from `pi-extension-core`) refuses before registering anything
— a `session_start` notification names the extension and the mismatch.

## What it does

- Overrides seven built-in tools — `read`, `write`, `edit`, `bash`, `grep`,
  `find`, `ls` — so each runs inside the container (`docker exec`) instead of
  on the host.
- Reads and writes therefore reflect the **container's** filesystem: the
  authoritative view the agent should see — in-container edits, build output,
  and volume-mounted paths like `node_modules` the host can't see — with no
  per-operation permission prompts.
- Warms the container at session start (core's `startContainer`), caches the
  resolved `remoteWorkspaceFolder` as the path anchor, and patches the system
  prompt so the model treats the cwd as the container workspace.
- Adds two **new** tools: `read_host`, the escape hatch that reads the
  **host** filesystem, and `list_host_docs`, an unprompted listing counterpart
  scoped to pi's own docs directory (see below).
- Prompts for confirmation before starting the container if pi was launched
  from the host's home directory itself (see below).
- Routes `user_bash` (the `!` prefix) into the container too, matching the
  LLM's own `bash` tool. `!!` is the escape hatch that stays on the host —
  see below.

### `!` vs `!!`

- **`!`** runs in the container, same as the agent's own `bash` tool — the
  command shows up in the transcript / LLM context, same as any `!` command.
- **`!!`** is **not** routed — it runs on the **host**, unrouted, using pi's
  own local shell. This is the escape hatch for host-only operations (e.g.
  managing the container itself with the `devc` CLI, if you have it). `!!` is
  also pi's own "exclude this from the model's context" prefix, so a `!!`
  command never reaches the LLM either.

### What it deliberately does _not_ do

- **No container lifecycle management beyond warm-up.** These containers are
  long-lived; stop or remove them yourself (`devc stop` / `devc down`, or
  `docker stop` / `docker rm`). The extension never stops or removes the
  container on pi exit.

## `read_host` — the gated host-read escape hatch

Every routed tool (`read`, `write`, …) touches the **container**. `read_host` is
the one tool that reads the **host** filesystem — for host files deliberately
kept out of the container (outside every bind/volume mount).

The tool factory, the per-hop symlink-safe mount barrier it's built on, and
its `list_host_docs` counterpart below all live in the shared
[`pi-extension-host-read-core`](../../shared/host-read-core) package (Phase 30), not in
this extension — this section documents the tools' behavior as *this*
extension instantiates them (`getMounts` backed by core's
`getContainerMounts`); see that package's README for the shared machinery
itself.

- **Parameters:** `{ path }` — an absolute host path.
- **Confirmation:** prompts (`ctx.ui.confirm`) before reading, **showing the
  canonical resolved path**. Declining returns a "denied" result and reads
  nothing. With no interactive UI it refuses outright. **Exception:** `.md`
  files under pi's own docs directory (`getDocsPath()` from
  `@earendil-works/pi-coding-agent`) are read without a prompt — static
  reference material shipped with pi itself, not user data. This exception
  only skips the confirmation; the mount-exclusion barrier below still applies
  unconditionally.
- **Output:** the file contents, truncated to 50KB / 2000 lines via pi's
  `truncateHead` / `DEFAULT_MAX_BYTES`, so it matches the built-in `read`.

## `list_host_docs` — unprompted directory listing, scoped to pi's docs root

The `.md` exception above only covers *reading* a known filename — there's no
way to browse the host filesystem to discover those filenames without a
prompt. `list_host_docs` (also from `pi-extension-host-read-core`) is the
discovery counterpart: it lists a directory under the same docs root, also
without a confirmation prompt, since gating *which filenames exist* more
strictly than gating *their contents* wouldn't add safety, just friction.

- **Parameters:** `{ path? }` — an absolute host path to a subdirectory of the
  docs root; omit (or pass `""`) to list the docs root itself.
- **Scope:** any path that doesn't resolve inside the (realpath'd) docs root
  is refused outright — no prompt, no fallback. Use `read_host` for anything
  else on the host.
- **Security:** identical machinery to `read_host` — the requested path goes
  through the same per-hop `resolveHostPath` (mount barrier + symlink-safe
  canonicalization) before the in-docs-root check, so a symlink planted inside
  the docs directory can't be used to list (or, via `read_host`, read) content
  outside it. Since Node's `readdir` has no `O_NOFOLLOW` equivalent, the
  canonical path is `lstat`'d again immediately before listing and refused if
  it now resolves to a symlink — the same belt-and-suspenders race guard
  `read_host`'s final `O_NOFOLLOW` open provides for reads.
- **Output:** entry names, one per line, directories suffixed with `/`.

### Mount-exclusion rule (the security invariant)

> `read_host` must never read host content the container could have influenced —
> i.e. anything under a mount **source**, reached directly **or via a symlink**.

The container can only write inside mount sources, so any container-controlled
symlink lives inside a mount. A final-only `realpath` check is insufficient: it
collapses the whole chain and cannot see that resolution _passed through_ a
mount. So `read_host` canonicalizes the requested path **one component at a
time** ([`pi-extension-host-read-core`](../../shared/host-read-core)'s
`resolve-host.ts`) and rejects the instant any resolved step — including an
intermediate symlink location or a symlink target — lands inside a mount
source. Symlink loops are capped and rejected. Examples of what is refused:

- a path _inside_ the workspace/mount (use the routed `read` for those);
- `<workspace>/leak → ~/secret` written from inside the container, requested as
  `read_host <workspace>/leak` (the in-mount symlink location trips the
  barrier);
- a host symlink `~/notes → <mount>/leak2 → ~/secret` — both endpoints are
  outside mounts, but resolution _transits_ the container-writable
  `<mount>/leak2` and is rejected.

The mount set is the **current container's** mounts only (from core's
`getContainerMounts`, i.e. `docker inspect`). The **cross-container /
poison-then-teardown** case — a bind source's bytes
persisting on the host after its container is removed — is knowingly out of
scope for v1; a persisted taint set would be the durable fix (future phase).

## `devcontainer_herdr_*` — orchestrating container agents from a host Herdr

Five tools for the topology where **pi runs on the host, Herdr runs on the
host, and the agents run inside the container** — the orchestrator creates
worktrees at host paths and fans agents out into the container that this
extension already routes into. Background and the measurements behind each
design choice:
[`devc-dev/docs/herdr-host-orchestrator.md`](https://github.com/bmingles/devc-dev/blob/main/docs/herdr-host-orchestrator.md).
The full workflow — branch naming, model selection, the Copilot trust
overlay, `detected` vs `ready`, driving and cleaning up a pane — is written up
once, in depth, in the package's
[`devcontainer-agent-fleet`](../../../skills/devcontainer-agent-fleet/SKILL.md)
skill; this section stays a tool reference.

They **register only when a `herdr` binary resolves** (`HERDR_BIN_PATH` →
`HERDR_BIN` → a `PATH` walk). An ordinary `pic` session never sees them, and
neither does the always-on orchestration nudge described below.

Three places say whether they loaded, in increasing detail:

- the **status line** gains a `+herdr` marker —
  `devcontainer: 1ca7c3d6720d (/workspaces/devc-dev) +herdr`;
- the **ready notification** at session start names them;
- **`/devcontainer`** reports whether they are active and, when they are not,
  why — the only place that gives a reason.

Note the status line and `/devcontainer`'s output are different things and look
similar; the status line is the one that is always on screen. If you are in a
Herdr pane and see no `+herdr`, run `/devcontainer` for the reason. The usual
one is a `herdr` that is a shell function or alias rather than a binary on
`PATH` — the resolver does an `existsSync` walk and cannot see shell functions,
and `runHerdr` spawns with `shell: false`, so such a `herdr` would not work at
call time either. Set `HERDR_BIN_PATH` to the real binary.

⚠️ These are **not** `extensions/herdr-worktrees`' `herdr_devc_*` tools. Those
run **inside** the container against a container Herdr; these run on the
**host** against a host Herdr. The two can never load in one process, but do
not confuse them in docs or a grep.

| Tool | Does |
| --- | --- |
| `devcontainer_herdr_worktree_path` | Derives the host path for a branch under the `<repo>.worktrees/<slug>` sibling convention, and the container path for it. Creates nothing, never calls `herdr`. |
| `devcontainer_herdr_worktree_create` | The same resolution, then `herdr worktree create`, then asserts the new checkout's `.git` link is relative. Pass `branch` (explicit) or `purpose` (derives `agent/<slug>`, disambiguated on collision). |
| `devcontainer_herdr_start_agent` | Launches an agent inside the container. With `workspaceId` (from `worktree_create`'s `openWorkspaceId`), runs in the pane that workspace already has; without it, splits a new Herdr pane. Returns a `paneId` and a `startupState`. See "The pane launcher" below for how the pane's command line is built. |
| `devcontainer_herdr_start_worktree_agent` | The one-call path: `worktree_create` then `start_agent`, chaining the create result's `hostPath`/`openWorkspaceId` through automatically. If create fails, its error is returned unchanged; if create succeeds but starting the agent fails, the worktree is **not** rolled back — the result names `hostPath`/`openWorkspaceId` for a retry against `start_agent`. |
| `devcontainer_herdr_worktree_list` | Lists a repo's worktrees in both path vocabularies, plus `containerVisible` (whether any bind mount of the routed container covers the worktree) — the thing `pi-herdr`'s own `herdr_worktree_list` can't report and, separately, rejects `workspaceId`+`cwd` together despite its schema suggesting both work (an upstream bug, not this tool's). |

### Structured `model`, and the escape hatch

`devcontainer_herdr_start_agent` and `devcontainer_herdr_start_worktree_agent`
both take an optional `model` (e.g. `"opus"`), translated to the flag the
agent kind's own CLI understands via `herdr-launch.ts`'s
`modelFlagForAgentKind` — currently `claude`, `copilot` and `pi`, all three
measured to take `--model <value>` (see that function's doc comment for the
exact transcripts and per-kind caveats: claude's value is a fixed alias,
copilot's and pi's are closer to a free-form model id/pattern). A kind with
no known flag fails `MODEL_UNSUPPORTED` — put the flag directly in
`agentArgs` instead of guessing one. An explicit `--model` already present in
`agentArgs` always wins over `model`, which is then dropped — stated in the
result text, never silently, since two `--model` flags is a CLI error on
most agents.

### The folder-trust overlay has no bypass flag (as of this writing)

Copilot's first run in a fresh worktree shows an interactive "do you trust
the files in this folder" overlay. Measured directly against `copilot
--help`, `copilot help permissions` and `copilot help config` (`@github/copilot`
1.0.83): `--allow-all-tools`/`--allow-all`/`--yolo` govern *tool* permissions,
a separate system from folder trust, and there is no flag or environment
variable that pre-accepts the trust prompt itself. (`trustedFolders` exists,
but only as a config-file setting under `~/.copilot/config.json` — not a
launch-time flag, so it isn't wired into `start_agent`.) No `trustFolder`
parameter is added for this reason; clear the overlay with `pi-herdr`'s
`herdr_send_keys` (arrow keys + Enter) — never `herdr_send_prompt`, which
types text a multi-choice overlay does not read as a selection.

### Startup state: `detected`, `ready`, `unknown`

`start_agent`/`start_worktree_agent` return `startupState`. `"detected"`
means Herdr's own poll matched a process rule — nothing more, and **not**
that the agent finished initializing. Passing `waitForReady: true` asks for
an additional check against the kind's own "ready to accept input" pane
pattern; no kind has a measured pattern yet (that needs a live host + built
devcontainer + Herdr to capture — see `herdr-launch.ts`'s
`readyPatternForAgentKind`), so `waitForReady` currently always resolves to
`"unknown"` rather than `"ready"`. Read the pane (`herdr_read_agent`) before
reporting success to a human either way.

### Two path vocabularies

An orchestrator that loads this extension holds both at once: its own routed
`read`/`bash` speak **container** paths, while Herdr's worktree and workspace
surfaces speak **host** paths. Every tool here therefore returns both,
explicitly named — `hostPath` and `containerPath`, never a bare `path`.

Host-path *inputs* (`repo`, `hostPath`) accept a leading `~`, which is expanded
against the host's home directory. These tools are called by a model rather
than a shell, so nothing upstream would otherwise expand it and `~/code/x`
would silently resolve to `<cwd>/~/code/x`. (`~user/...` is not expanded —
that needs a passwd lookup.) Note `devc`'s own `--cwd` deliberately does *not*
do this: there a shell owns the expansion.

The container's mount table (`docker inspect`, read host-side through core's
`getContainerMounts`) is what relates them, and it is simultaneously the safety
guard: a host path that no bind mount covers is exactly a path the container
cannot see. That failure is `NOT_MOUNTED_IN_CONTAINER`, and the fix is a
`<repo>.worktrees` sibling mount in `.devc/devc.jsonc` (via `devc config`) plus
a rebuild — not a retry.

`ABSOLUTE_GITDIR` is the same class of failure: Herdr reported success, but the
checkout's `gitdir:` link names a host path that does not resolve inside the
container. Fix it with `worktree.useRelativePaths=true` on the **host** git
(git ≥ 2.48), then remove and recreate the worktree.

### Create, then attach — one pane, not two

`herdr worktree create` always opens a new Herdr workspace with a host-shell
pane in it, whether or not the caller wants one — that's Herdr's own
behavior, not this extension's. Calling `devcontainer_herdr_start_agent`
without `workspaceId` afterwards does not use that pane: it splits a *second*
one off pi's own pane instead, leaving the first sitting idle with nothing to
close it — `herdr_worktree_remove` only knows to close the workspace Herdr
itself opened, not an unrelated split pane it has no record of.

Passing `workspaceId` — `worktree_create`'s `openWorkspaceId` result — avoids
both problems: `start_agent` runs the agent in the pane that workspace
already has (`herdr pane list --workspace <id>`) instead of splitting, so
there is one pane per worktree, and removing the worktree closes it along
with the workspace. This is the first-class create-then-attach path; the
split behavior remains for attaching to a worktree that already existed
before this call.

### The pane launcher: `docker exec` or `devc`

`devcontainer_herdr_start_agent` builds the command line it types into the
pane one of two ways:

- The **`docker`** form — `HERDR_AGENT=<kind> docker exec -it -u <user> -w
  <containerPath> … <id> sh -lc 'exec <command> …'` — always available, and
  the only form that can carry `env` (as `-e K=V`) or launch any of the ~20
  agent kinds `--kind` recognizes.
- The **`devc`** form — `devc <kind> --cwd <containerPath> [agentArgs…]` —
  only for the three kinds `devc` has a dedicated subcommand for
  (`claude`/`copilot`/`pi`; `devc attach` has no `EXTRA_ARGS`, so it can't
  stand in for the rest) and only when `env` is empty (`devc`'s launch
  subcommands have no environment-variable flag as of this writing). It buys
  `TERM`/`TERM_PROGRAM`/`TMUX` propagation the `docker` form drops, the
  attach tint and title, and identity rotation if a human later takes the
  pane over via `devc`'s own watcher-plus-sidecar (`devc-tools`'
  `devc/herdr.ts`) — that sidecar is what actually asserts `HERDR_AGENT` for
  this form, so the pane command line itself carries none.

**Selection** is auto-detect by default: a `devc` binary resolved on `PATH`
at extension load, and the requested kind covered, picks the `devc` form;
otherwise the `docker` form, unchanged from before this existed. Pass
`launcher: "docker"` or `launcher: "devc"` on `devcontainer_herdr_start_agent`
to force one — an explicit `launcher: "devc"` **errors** (`DEVC_LAUNCHER_UNAVAILABLE`)
rather than silently falling back to `docker` when `devc` isn't resolvable,
the kind isn't one of the three, or `env` was passed; an explicit request
deserves a clear answer, not a silent substitution.

Note this is a different route from `agent start --kind` — Herdr's own
agent-start command was tried and rejected for this launcher (see the
`devc-launcher-variant` plan); it changes only the command line typed into
the pane, nothing about how Herdr detects the agent once it's there.

### After the start

`devcontainer_herdr_start_agent` deliberately stops at "the agent is running in
this pane". Everything after that is pane-scoped and topology-agnostic, and
`pi-herdr` already does it well — drive the returned `paneId` with its
`herdr_send_prompt` / `herdr_wait_agent` / `herdr_read_agent`.

Three caveats come with the launch, all inherited from asserting identity with
`HERDR_AGENT` rather than letting Herdr detect it:

- **Trust `working` and `blocked`; distrust `idle`.** The positive states come
  from Herdr's own screen manifests, evaluated against terminal output, which
  crosses the container boundary unchanged. `idle` is a fallback that covers
  "at its prompt", "not started yet", "failed to launch" and "stuck on an auth
  prompt" alike.
- **Identity rides the wrapper, not the agent.** Through `docker exec` it
  exists before the agent starts and survives whatever happens to it. You are
  watching the lifetime of the container command.
- **`shift+tab` does not survive `docker exec -it`.** It will not cycle Claude
  Code's permission mode — pass an explicit `--permission-mode` in `agentArgs`
  instead. Plain keys and `herdr agent prompt` work normally.

### The always-on orchestration nudge

Beyond the tools and the skill, `before_agent_start` appends a few sentences
to the system prompt — gated on the same `herdrAvailable` flag as the tools,
so a session with no `herdr` binary sees nothing — naming `start_worktree_agent`
as the default way to isolate substantial new work in a worktree and hand it
to an agent, and pointing at the `devcontainer-agent-fleet` skill for
everything else. It's a default, not a law: a one-line fix, a question, or
work the user is clearly doing themselves is unaffected. The block is a
plain constant with no per-turn interpolation, so it's byte-identical every
turn — it does not defeat the provider's prompt-prefix cache.

## Home-directory start confirmation

The devcontainer's workspace mount binds `hostCwd` (where pi was launched)
into the container. If `hostCwd` is the host's home directory itself — e.g.
running `pi -e .../extensions/host/devcontainer` from `~` rather than a project
under it — that mount is the user's **entire home directory**: SSH keys,
credentials, every other project. Before starting the container in that case,
the extension prompts (`ctx.ui.confirm`); declining aborts the start with no
container created. The decision is cached for the rest of the pi session (no
re-prompting on later tool calls), and re-evaluated fresh in the next `pi`
process.

This check only ever compares `hostCwd` to the host home directory — it does
not inspect any mount configuration (the default template's `~/.claude/*`
mounts, a project's `.devc/devc.json`, or its own `.devcontainer.json` all stay
silent, by design).

## Path handling

Every path a routed tool receives is interpreted as a **container** path:

- a relative path resolves against `remoteWorkspaceFolder`;
- an absolute path under the host cwd is rewritten into `remoteWorkspaceFolder`;
- any other absolute path is treated as a container-absolute path as-is.

## Usage

```bash
cd /path/to/project
pi -e /path/to/pi-dev-extensions/extensions/host/devcontainer
```

`pi -e <dir>` loads the directory's `package.json` `pi.extensions` entry
(`./src/index.ts`). For auto-discovery / `/reload`, copy or symlink it into
`~/.pi/agent/extensions/` instead.

Once loaded, `/devcontainer` reports the routed container's id and workspace
folders.

## Requirements

- **Docker** — a running daemon and the `docker` CLI. That is the whole
  runtime story for the seven routed built-ins: the container lifecycle comes
  from the `@devc-tools/core` npm dependency (which carries the devcontainer
  CLI as a dependency of its own and runs it with this same Node), and the
  routed commands are `docker exec`. No `devc` binary on `PATH` is required
  for any of that, and no environment-variable override pointing at one
  exists. The
  [`devc`](https://github.com/bmingles/devc-tools/tree/main/devc) CLI is
  still useful alongside this extension (`devc stop`, `devc down`,
  `devc config`), but it is complementary, not required — everything still
  works with only Docker and Node.
- **Node.js ≥ 22.19.0** — native `.ts` type-stripping (no build step) needs
  Node's default-on stripping support (22.18.0+); this package's source uses
  no non-erasable TS syntax, so the extra `--experimental-transform-types`
  flag some code needs is never required. (The repo-root `.nvmrc` pins a
  newer version for local dev — that's not a floor.)

**The Herdr orchestration tools below add nothing to this list — with one
precise nuance.** They shell out to a `herdr` binary if one is present and
are registered only when it resolves; without Herdr they simply do not
register, no `devc` needed either way. Once registered, though,
`devcontainer_herdr_start_agent` *does* look for `devc` on `PATH`: when one
resolves and the requested agent kind is one `devc` has a dedicated
subcommand for (`claude`/`copilot`/`pi`), it routes the pane's command line
through `devc <kind> --cwd <containerPath>` instead of a raw `docker exec`,
automatically, for the benefits under "The pane launcher" below. Absent or
uncovered, the `docker exec` form is used exactly as before — nothing about
this extension's own requirements changes, and a reader who assumes
otherwise will add a dependency that is not actually needed for anything
this extension itself does.

## Development

Part of the repo-root npm workspace (see the root README's
"Package layout" section) — `npm install` here works standalone,
but a single `npm install` from the repo root covers all eight packages at
once.

```bash
npm install        # install pi (types) + typescript + @types/node (dev only)
npm run typecheck  # tsc --noEmit against pi's real types
npm test           # node --test (unit tests, injected spawn — no docker)
```

`@devc-tools/core` is a normal npm dependency of this package, on a caret
range with a floor at the lowest version that carries everything used here
(currently `^0.1.3`, for `mount_paths.ts`). It is pre-1.0, so the pieces
consumed (`buildExecArgs`, `startContainer`'s `StartOptions`,
`hostToContainerPath`) are not a stability promise yet — raise the floor when a
new one is needed, and the committed lockfile pins the exact resolution.

The unit tests inject a fake spawn for `docker exec` and a fake
`startContainer` / devcontainer runner for the lifecycle, so they need neither
Docker nor a real container. The real end-to-end check is manual: run
`pi -e …` against a project and confirm reads/writes/`bash`/`!` land inside the
container (e.g. a file the agent writes is visible via
`docker exec <id> cat …`), while `!!` still runs on the host.
