# pi sbx extension

A [pi](https://github.com/earendil-works) coding-agent extension that runs `pi`
on the **host** and routes its built-in filesystem/shell tools into a
**Docker Sandboxes** (`sbx`) sandbox.

It is the same shape as
[`extensions/devcontainer`](../devcontainer) — override the built-in
tools so the agent's filesystem/shell operations land in an isolated
environment instead of the host, with no per-operation permission prompts —
but the isolation boundary here is an `sbx` sandbox instead of a
devcontainer. It is a **separate extension**, not a mode of
`extensions/devcontainer`: the two backends' lifecycle, path model, and
mount-inspection primitives differ enough that sharing one extension would
mean branching nearly every seam on backend rather than sharing real logic.
See the [Phase 31 plan](../../.plans/implemented/phase31-pi-sbx-extension-routing.md)
for the full "why a separate extension" reasoning.

## What it does

- Overrides seven built-in tools — `read`, `write`, `edit`, `bash`, `grep`,
  `find`, `ls` — so each runs inside the sandbox (`sbx exec`) instead of on
  the host.
- Reads and writes therefore reflect the **sandbox's** filesystem. Because
  `sbx` mounts the workspace at the **same path** as on the host (an
  identity mount), no path translation happens — unlike
  `extensions/devcontainer`, there is no `toContainerPath`/
  `remoteWorkspaceFolder` remapping layer at all.
- Warms the sandbox at session start. First checks `sbx ls --json` for an
  existing `shell`-agent sandbox already mounting this exact `hostCwd`; if
  one or more are found, prompts you to pick one to attach to (or create a
  new one anyway). Otherwise (or with that choice made) runs `sbx run
  --name <name> -d shell <hostCwd>` — either `<name>` you picked, or one
  derived from `hostCwd` for a fresh sandbox. Either way, caches the
  resolved sandbox name/ID and reuses it for every routed tool call. See
  "Finding an existing sandbox for this workspace" below.
- Adds two **new** tools: `read_host`, the escape hatch that reads the
  **host** filesystem, and `list_host_docs`, an unprompted listing
  counterpart scoped to pi's own docs directory — both from the shared
  [`pi-extension-host-read-core`](../host-read-core) package (Phase 30).
- Prompts for confirmation before starting the sandbox if pi was launched
  from the host's home directory itself (same rationale as devcontainer's
  check — see below).
- Routes `user_bash` (the `!` prefix) into the sandbox too, matching the
  LLM's own `bash` tool. `!!` is the escape hatch that stays on the host —
  see below.

### `!` vs `!!`

- **`!`** runs in the sandbox, same as the agent's own `bash` tool — the
  command shows up in the transcript / LLM context, same as any `!` command.
- **`!!`** is **not** routed — it runs on the **host**, unrouted, using pi's
  own local shell. This is the escape hatch for host-only operations (e.g.
  managing the sandbox itself via `sbx`). `!!` is also pi's own "exclude
  this from the model's context" prefix, so a `!!` command never reaches the
  LLM either.

### What it deliberately does _not_ do

- **No sandbox lifecycle management beyond warm-up.** `sbx` sandboxes are
  user-managed; use `sbx stop` / `sbx rm` yourself. The extension never
  stops or removes the sandbox on pi exit.
- **No `before_agent_start` system-prompt patch.** Because sandbox paths
  equal host paths, pi's own "Current working directory: `<hostCwd>`" line
  is already accurate — there's nothing incorrect to replace (unlike
  devcontainer's `remoteWorkspaceFolder` rewrite).

## Path handling

Every path a routed tool receives is used **directly**, with no
translation: `sbx` mounts the workspace at the same path as on the host, so
a host-side path the model emits is already the correct sandbox-side path.
This is `extensions/sbx`'s one structural simplification over
`extensions/devcontainer` — there is no `paths.ts` path-mapping module
here beyond `isHomeDirectory` (see Concept boundaries in the plan).

## `read_host` / `list_host_docs` — the gated host-read escape hatch

Every routed tool (`read`, `write`, …) touches the **sandbox**. `read_host`
is the one tool that reads the **host** filesystem — for host files
deliberately kept out of the sandbox (outside its one mount).

The tool factories, the per-hop symlink-safe mount barrier they're built on,
and the confirmation/`.md`-docs-exception behavior all live in the shared
[`pi-extension-host-read-core`](../host-read-core) package (Phase 30), not
in this extension — see that package's README for the shared machinery
itself, and `extensions/devcontainer/README.md` for a fuller writeup of
the tools' user-facing behavior (identical here).

### How the single-mount model simplifies the barrier vs. devcontainer's

`extensions/devcontainer`'s `getMounts` calls `devc mounts <hostCwd>
--json` — a dynamic, N-entry table (bind + volume mounts) that can change
between sandboxed runs. `extensions/sbx`'s `getMounts` (in `src/tools.ts`)
needs **no `sbx` call at all**: `sbx` mounts the entire workspace 1:1 at
`hostCwd`, so the mount table is always exactly the single, statically-known
entry:

```ts
[{ type: "bind", source: hostCwd, destination: hostCwd, rw: true }]
```

This is not a simplification of some richer sbx mount table — it's the
_whole_ table, by construction of how `sbx run` mounts a workspace. The
practical effect: any host path outside `hostCwd` is eligible for
`read_host` (subject to the usual confirmation prompt and symlink-safe
barrier); any path inside `hostCwd` is refused — use the routed `read` for
those instead.

## Home-directory start confirmation

`sbx` mounts the workspace directory as given. If `hostCwd` is the host's
home directory itself — e.g. running `pi -e .../extensions/sbx` from `~`
rather than a project under it — that mount is the user's **entire home
directory**: SSH keys, credentials, every other project. Before starting
the sandbox in that case, the extension prompts (`ctx.ui.confirm`);
declining aborts the start with no sandbox created. The decision is cached
for the rest of the pi session (no re-prompting on later tool calls), and
re-evaluated fresh in the next `pi` process.

## Sandbox naming

`sbx`'s own default naming (`<agent>-<workdir>`) isn't guaranteed to satisfy
`sbx`'s documented `--name` charset for an arbitrary `hostCwd` basename
(spaces, unicode, etc.), and doesn't disambiguate two different absolute
paths sharing a basename. `deriveSandboxName` (`src/name.ts`) instead
produces a deterministic, charset-safe name: the sanitized workspace
basename plus the first 8 hex characters of a SHA-256 hash of the full,
resolved `hostCwd`, prefixed with `pi-` (e.g. `pi-my-project-1a2b3c4d`) —
identifiable in `sbx ls` output and stable across processes.

This is only the name used for sandboxes **this extension creates** —
see the next section for how an already-existing sandbox (under any name)
is found and reused instead.

## Finding an existing sandbox for this workspace

Before creating anything, the extension runs `sbx ls --json` and filters
its `sandboxes` array to entries where `agent == "shell"` and `workspaces`
contains this exact `hostCwd` (compared via `path.resolve` on both sides,
so a relative or trailing-slash `hostCwd` still matches). This catches
sandboxes this extension didn't itself create — started manually, by an
older version of this extension, or under `sbx`'s own default naming (e.g.
`shell-my-project`) — which the old derived-name-only lookup silently
missed, leaving them orphaned while a second, differently-named sandbox
got created alongside them.

- **No match** — falls through to today's behavior: `sbx run --name
  <derivedName> -d shell <hostCwd>`.
- **One or more matches, UI available** — prompts with a picker listing
  each match's name, status, and short ID, plus a "Create a new sandbox"
  option; the chosen sandbox's *actual* name is passed to `sbx run --name`
  instead of the derived one (so `sbx run`'s own attach-by-name behavior
  reattaches it, restarting it first if `stopped`).
- **Exactly one match, no UI** (e.g. print/RPC mode) — attaches to it
  without prompting; nothing to ask through, and it's unambiguous.
- **Multiple matches, no UI** — fails loudly rather than guessing which
  sandbox to route tool calls into; the error lists the candidate names and
  suggests running interactively, or `sbx stop`/`sbx rm`-ing the ones you
  don't want.
- **`sbx ls --json` itself fails** (e.g. transient `sbx` hiccup) — degrades
  to the no-match path (create via derived name) rather than blocking
  startup; a warning is shown either way.

This lookup runs once per `pi` process, same as the sandbox warm-up itself
(cached alongside it) — no re-prompting on later tool calls.

## Usage

```bash
cd /path/to/project
pi -e /path/to/pi-dev-extensions/extensions/sbx
```

`pi -e <dir>` loads the directory's `package.json` `pi.extensions` entry
(`./src/index.ts`). For auto-discovery / `/reload`, copy or symlink it into
`~/.pi/agent/extensions/` instead.

Once loaded, `/sbx` reports the routed sandbox's name, ID, and workspace
path.

## Requirements

- **`sbx`** — the [Docker Sandboxes](https://docs.docker.com/reference/cli/sbx/)
  CLI, the extension's only runtime dependency. Always spawned as `sbx` from
  `PATH` — unlike `devc` (this repo's own CLI), there is no
  `$SBX_BIN`-style override, since `sbx` is purely an external Docker
  Desktop binary with no compiled-vs-run-from-source distinction to support.
- **Node.js ≥ 22.19.0** — native `.ts` type-stripping (no build step) needs
  Node's default-on stripping support (22.18.0+); this package's source uses
  no non-erasable TS syntax, so the extra `--experimental-transform-types`
  flag some code needs is never required. (The repo-root `.nvmrc` pins a
  newer version for local dev — that's not a floor.)

## Out of scope (v1)

- **Cross-sandbox / poison-then-teardown.** Same gap
  `extensions/devcontainer` already documents as out of scope: a removed
  sandbox's bytes could persist on the host bind-mount source after the
  sandbox itself is gone; `read_host`'s mount barrier only ever excludes the
  *current* sandbox's mount, not a historical taint set. Not re-litigated
  per backend — see that extension's README.
- **`sbx ls --json` for mount introspection.** `sbx ls --json` *is* used now
  (see "Finding an existing sandbox for this workspace" above), but only for
  its `agent`/`status`/`workspaces` fields — the static single-entry
  `getMounts` above still doesn't call it, since sbx's mount model needs no
  introspection to determine (see that section).
- **Sandbox lifecycle management** (stop/rm) — user-managed, see above.

## Development

Part of the repo-root npm workspace (see the root README's
"Package layout" section) — `npm install` here works standalone,
but a single `npm install` from the repo root covers all four packages at
once.

```bash
npm install        # install pi (types) + typebox + typescript + @types/node,
                    # and resolve the file:../host-read-core dependency
npm run typecheck  # tsc --noEmit against pi's real types
npm test           # node --test (unit tests, injected spawn — no sbx/Docker)
```

The unit tests inject a fake spawn / runner, so they need neither `sbx` nor
Docker. `read_host`/`list_host_docs`'s own algorithm (the symlink-safe
barrier, docs-path exception, etc.) is already covered by Phase 30's
`pi-extension-host-read-core` test suite and is not re-tested here — this
package only tests its own `getMounts` and the `sbx`-spawning pieces
(`name.ts`, `sbx.ts`, `tools.ts`, `paths.ts`).

### A note on the `sbx` CLI facts this extension assumes

This extension was implemented without a real `sbx` binary available (see
the plan's Testing section) — most of its flag shapes (`sbx run --name
<name> -d shell <hostCwd>`, `sbx exec -i -w <cwd> -e K=V... <name>
<argv...>`, no `--` separator before the routed command, no infra-vs-command
exit code) are drawn from `docs.docker.com/reference/cli/sbx/*`, not a live
binary — those pages turned out to be documentation stubs with no actual
flag/behavior content, so this is weaker than it sounds. The one exception:
`sbx ls --json`'s shape (`{ "sandboxes": [{ name, id, agent, status,
workspaces: string[] }, ...] }`) *was* confirmed against a real binary's
output (a `stopped` sandbox with an empty `PORTS` column), which is what
`sbxLs`/`findSandboxesForWorkspace` (`src/sbx.ts`) parse. Still unconfirmed
against a real binary: whether `sbx run --name <existing-but-stopped-name>`
actually restarts it in place (assumed, not verified — no separate `sbx
start` is called) rather than erroring or recreating. The real end-to-end
check is the manual smoke test below, run by a human on a host where `sbx`
actually exists.

**Manual smoke test (run on a host with `sbx` installed — not part of this
extension's own automated test suite):**

- `cd <project> && pi -e extensions/sbx`, then have the agent
  `read`/`write`/`edit`/`bash` — verify effects land **inside** the sandbox
  (e.g. a file the agent writes is visible via `sbx exec <derived-name> --
  cat …`, and a `bash` command uses the sandbox's toolchain).
- Confirm `!echo $PATH` runs **inside** the sandbox, and `!!echo $PATH`
  still runs on the **host**.
- Confirm `sbx ls` shows a sandbox named per `deriveSandboxName`'s scheme.
- Confirm starting from `$HOME` triggers the confirmation prompt, and
  declining aborts with no sandbox created.
- Create a sandbox for a workspace outside this extension (e.g. plain `sbx
  run --name my-manual-sbx shell <dir>`), `sbx stop` it, then launch `pi -e
  extensions/sbx` from that same `<dir>` — confirm the picker offers
  `my-manual-sbx` and that picking it reattaches (and restarts) it rather
  than creating a second, derived-name sandbox alongside it.
- Same setup, but with two matching sandboxes for one workspace — confirm
  both appear in the picker, and that "Create a new sandbox" still works.
- `read_host` on a host path outside `hostCwd` (e.g. `~/.config/foo`) →
  prompts with the resolved path, reads on approve.
- `read_host` on a path *inside* `hostCwd` → refused (use the routed `read`
  for those).
- `list_host_docs` lists pi's docs directory with no prompt, same as
  devcontainer's.
- Verify `rg` is actually present in the `shell` agent kit's default image
  (used by `find`'s `glob` and by `grep`) — `src/tools.ts`'s `glob`
  implementation assumes it is; if it turns out missing, that implementation
  needs a `find <cwd> -type f` fallback (not currently present).
