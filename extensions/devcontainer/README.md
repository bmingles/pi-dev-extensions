# pi devcontainer extension

A [pi](https://github.com/earendil-works) coding-agent extension that runs `pi`
on the **host** and routes its built-in filesystem/shell tools into a
**devcontainer**. The container's lifecycle is driven **in-process** through
[`@devc-tools/core`](https://github.com/bmingles/devc-tools/tree/main/devc-core)
— devc's own start/mounts logic as an npm library — and the routed commands run
via `docker exec`. There is no `devc` binary to install (see Requirements
below).

It is the same shape as pi's bundled
[`gondolin`](https://github.com/earendil-works/gondolin) example (which routes
into a micro-VM), but the isolation boundary here is a long-lived devcontainer
of the kind `devc` manages.

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
[`pi-extension-host-read-core`](../host-read-core) package (Phase 30), not in
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
time** ([`pi-extension-host-read-core`](../host-read-core)'s
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

## Home-directory start confirmation

The devcontainer's workspace mount binds `hostCwd` (where pi was launched)
into the container. If `hostCwd` is the host's home directory itself — e.g.
running `pi -e .../extensions/devcontainer` from `~` rather than a project
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
pi -e /path/to/pi-dev-extensions/extensions/devcontainer
```

`pi -e <dir>` loads the directory's `package.json` `pi.extensions` entry
(`./src/index.ts`). For auto-discovery / `/reload`, copy or symlink it into
`~/.pi/agent/extensions/` instead.

Once loaded, `/devcontainer` reports the routed container's id and workspace
folders.

## Requirements

- **Docker** — a running daemon and the `docker` CLI. That is the whole
  runtime story: the container lifecycle comes from the `@devc-tools/core` npm
  dependency (which carries the devcontainer CLI as a dependency of its own and
  runs it with this same Node), and the routed commands are `docker exec`. No
  `devc` binary on `PATH`, and no environment-variable override pointing at
  one — both are gone. The
  [`devc`](https://github.com/bmingles/devc-tools/tree/main/devc) CLI is
  still useful alongside this extension (`devc stop`, `devc down`,
  `devc config`), but it is complementary, not required.
- **Node.js ≥ 22.19.0** — native `.ts` type-stripping (no build step) needs
  Node's default-on stripping support (22.18.0+); this package's source uses
  no non-erasable TS syntax, so the extra `--experimental-transform-types`
  flag some code needs is never required. (The repo-root `.nvmrc` pins a
  newer version for local dev — that's not a floor.)

## Development

Part of the repo-root npm workspace (see the root README's
"Package layout" section) — `npm install` here works standalone,
but a single `npm install` from the repo root covers all four packages at
once.

```bash
npm install        # install pi (types) + typescript + @types/node (dev only)
npm run typecheck  # tsc --noEmit against pi's real types
npm test           # node --test (unit tests, injected spawn — no docker)
```

`@devc-tools/core` is a normal npm dependency of this package, pinned to an
exact version: it is pre-1.0, and the pieces consumed here (`buildExecArgs`,
`startContainer`'s `StartOptions`) are not a stability promise yet.

The unit tests inject a fake spawn for `docker exec` and a fake
`startContainer` / devcontainer runner for the lifecycle, so they need neither
Docker nor a real container. The real end-to-end check is manual: run
`pi -e …` against a project and confirm reads/writes/`bash`/`!` land inside the
container (e.g. a file the agent writes is visible via
`docker exec <id> cat …`), while `!!` still runs on the host.
