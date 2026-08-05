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
- Warms the sandbox at session start (`sbx run --name <name> -d shell
  <hostCwd>`), caches the resolved sandbox name/ID, and reuses it for every
  routed tool call.
- Adds two **new** tools: `read_host`, the escape hatch that reads the
  **host** filesystem, and `list_host_docs`, an unprompted listing
  counterpart scoped to pi's own docs directory — both from the shared
  [`pi-extension-host-read-core`](../host-read-core) package (Phase 30).
- Prompts for confirmation before starting the sandbox if pi was launched
  from the host's home directory itself (same rationale as devcontainer's
  check — see below).

### What it deliberately does _not_ do

- **`user_bash` (bare `!`) is not routed.** It is user-invoked and stays on
  the host as your own shell / escape hatch.
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
- **`sbx ls --json` / any other `sbx` introspection.** Deliberately unused —
  the static single-entry `getMounts` above makes it unnecessary, and the
  schema of `sbx ls --json` has not been verified against a real binary (see
  Testing below).
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
the plan's Testing section) — its flag shapes (`sbx run --name <name> -d
shell <hostCwd>`, `sbx exec -i -w <cwd> -e K=V... <name> <argv...>`, no `--`
separator before the routed command, no infra-vs-command exit code) are
drawn from `docs.docker.com/reference/cli/sbx/*`, not a live binary. The
real end-to-end check is the manual smoke test below, run by a human on a
host where `sbx` actually exists.

**Manual smoke test (run on a host with `sbx` installed — not part of this
extension's own automated test suite):**

- `cd <project> && pi -e extensions/sbx`, then have the agent
  `read`/`write`/`edit`/`bash` — verify effects land **inside** the sandbox
  (e.g. a file the agent writes is visible via `sbx exec <derived-name> --
  cat …`, and a `bash` command uses the sandbox's toolchain).
- Confirm bare `!echo $PATH` still runs on the **host**.
- Confirm `sbx ls` shows a sandbox named per `deriveSandboxName`'s scheme.
- Confirm starting from `$HOME` triggers the confirmation prompt, and
  declining aborts with no sandbox created.
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
