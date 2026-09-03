# pi-dev-extensions

A [pi](https://github.com/earendil-works) coding-agent package bundling eight
Node/TypeScript packages for routing pi's tools through an isolated dev
environment, keeping the host machine awake while pi works unattended, and
creating Herdr worktrees — and launching Herdr agents — under this host's
layout, from either side of the container boundary.

Extensions are grouped by **where the extension process runs** — the machine-
checked fact is each extension's `requireSide` declaration (see
`extensions/shared/extension-core`), and the directory groups mirror it:

- **`extensions/host/`** — runs on the **host**
  - **[`devcontainer`](#extensionshostdevcontainer)** — routes pi's built-in
    tools into a devcontainer via `devc`; also, when a `herdr` binary is
    present, three tools for creating container-visible worktrees and
    launching container agents into Herdr panes
  - **[`caffeinate`](#extensionshostcaffeinate)** — keeps the Mac awake
    (`caffeinate`) while an agent run is active
- **`extensions/vm/`** — also runs on the **host**. ⚠️ The name is the one
  thing here that can be misread, and this repo has form for that: it does
  **not** mean "runs in a VM" — it means "routes into one". Both extensions
  below run on the host exactly like `devcontainer` does; only what they
  route *into* differs.
  - **[`sbx`](#extensionsvmsbx)** — routes pi's built-in tools into a Docker
    Sandboxes (`sbx`) sandbox instead of a devcontainer
  - **[`gondolin`](#extensionsvmgondolin)** — routes pi's built-in tools into
    a local gondolin micro-VM instead of a devcontainer or sandbox
- **`extensions/container/`** — runs **inside** a container
  - **[`herdr-worktrees`](#extensionscontainerherdr-worktrees)** — for a pi
    running **inside** a devcontainer alongside `pi-herdr`: derives a safe
    `herdr worktree create --path` under the `<repo>.worktrees/<branch>`
    sibling convention and guards against one that isn't bind-mounted. Can no
    longer be loaded on the host at all — see its section below.
- **`extensions/shared/`** — libraries, not independently `pi -e`-loadable;
  side-agnostic *by nature*, not by luck (see § Package layout)
  - **[`extension-core`](#extensionssharedextension-core)** — the
    `requireSide` guard every extension above starts with, plus generic
    tool-result helpers
  - **[`herdr-core`](#extensionssharedherdr-core)** — the `herdr` CLI
    plumbing and the `<repo>.worktrees/<slug>` derivation shared by both
    Herdr tool families
  - **[`host-read-core`](#extensionssharedhost-read-core)** — the
    `read_host`/`list_host_docs` tool machinery consumed by `devcontainer`,
    `sbx`, and `gondolin`

## Requirements

- Node.js ≥ 22.19.0 — most packages use native `.ts` type-stripping (no build
  step), which needs Node's default-on stripping support (22.18.0+). The
  extra `--experimental-transform-types` flag some non-erasable TS syntax
  needs is never required here since none of the source uses it (`.nvmrc`
  pins a newer version for local dev, but that's not a floor).
  `extensions/vm/gondolin` needs a newer floor still — see below.
- Node.js ≥ 23.6.0 and QEMU installed for `extensions/vm/gondolin`
  specifically (`@earendil-works/gondolin`'s own requirements)
- Docker (a running daemon and the `docker` CLI) for
  `extensions/host/devcontainer` — it drives the container lifecycle
  in-process via its `@devc-tools/core` npm dependency, so no `devc` binary
  is needed; `sbx` on `PATH` for `extensions/vm/sbx` (see each package's
  README)

## Shell setup

`scripts/bash_aliases_pic.sh` defines `pic` — `pi` launched with the
`caffeinate` and `devcontainer` extensions loaded, by absolute path, so it
works from any directory. Source it from your `~/.bashrc` or `~/.zshrc`:

```bash
source /path/to/pi-dev-extensions/scripts/bash_aliases_pic.sh
```

Nothing else has to be on `PATH` for the `devcontainer` extension beyond
`docker`: the container lifecycle comes from its `@devc-tools/core` npm
dependency, running in pi's own Node process. See
[`extensions/host/devcontainer/README.md`](extensions/host/devcontainer/README.md).

## Package layout

This repo follows pi's own [package conventions](https://github.com/earendil-works)
(`docs/packages.md`): a package can declare its resources in `package.json`
under the `pi` key. Each subfolder under `extensions/<group>/` is an
independently loadable extension (or, for the three `shared/` packages, a
library consumed only via `import`) with its own `package.json`, `src/`, and
tests.

**The `shared/` rule:** something lives there only if it is side-agnostic *by
nature* — it doesn't need to know which side of the container boundary it's
on. The moment a unit needs to know, it moves out to that side. `herdr-core`
and `host-read-core` are side-agnostic by construction (every *guard* around
them lives in the consumers); `extension-core`'s `requireSide` is the guard
itself, so it necessarily lives where every extension can reach it before
declaring its own side.

**Mutual exclusion crosses the `host/`/`vm/` split.** `devcontainer`, `sbx`,
and `gondolin` all override the same seven built-in tools and are mutually
exclusive — only one may be loaded at a time (see each extension's own
section below). This layout splits that group across two directories, which
makes the constraint less visible in the tree than a single flat directory
would — it is not lost, just no longer implied by the folder name. The
process-wide `ROUTING_MARKER_KEY` check (in each of the three) still detects
two loaded at once and warns at `session_start`.

The repo root's `package.json` does double duty:

- It's a bare pi package manifest — `keywords: ["pi-package"]` + a
  `pi.extensions` array listing each loadable extension's entry file at its
  grouped path (`extension-core`/`herdr-core`/`host-read-core` are never
  listed — they're libraries, not `-e`-loadable). This is what `pi
  install`/`pi -e` look for.
- It's also the real npm workspaces root (`"workspaces": ["extensions/*/*"]`
  — one level deeper than a flat layout, to reach each group's packages) —
  one `npm install` from repo root hoists and links all eight packages
  correctly regardless of order. This is also exactly what `pi install
  git:...`'s own automatic `npm install` step runs, so installing straight
  from GitHub needs no extra manual step.

The only footprint at the true repo root is a gitignored `node_modules/` and
a committed `package-lock.json` (the real, consolidated lockfile for all
eight packages) — no source lives there, only `package.json` plus install-time
artifacts.

### Installing straight from GitHub

Per pi's `docs/packages.md`, `pi install git:host/user/repo@ref` (or
`pi -e git:...` to try it without persisting) clones the whole repository,
runs `npm install` at its root (setting up all eight packages via the
workspaces root above), and loads whichever paths its `pi.extensions`
manifest lists — **all five loadable extensions by default**. `devcontainer`,
`sbx`, and `gondolin` are mutually exclusive (see above), so pick one at
install time using pi's package filtering, either via `pi config` after
installing, or by writing the filtered form directly into settings up front
(pi installs any package listed there automatically once the project is
trusted — no separate `pi install` step needed). Use `.pi/settings.json` to
scope it to one project, or `~/.pi/agent/settings.json` to make it the
default for every project on the machine — same `packages` shape either way:

```json
// .pi/settings.json (project-local) or ~/.pi/agent/settings.json (global)
// — enables only extensions/host/devcontainer
{
  "packages": [
    {
      "source": "git:github.com/bmingles/pi-dev-extensions@main",
      "extensions": ["extensions/host/devcontainer/src/index.ts"]
    }
  ]
}
```

Swap the one `extensions` entry for `"extensions/vm/sbx/src/index.ts"` or
`"extensions/vm/gondolin/src/index.ts"` to get `sbx` or `gondolin` instead.

The grouping pays off here for a container-side pi that only wants
`herdr-worktrees`, or a host-side pi that wants everything under `host/`: pi's
filter field accepts globs (`!pattern` excludes, `+path`/`-path` force an
exact path in/out — see `docs/packages.md`'s Package Filtering section), so
one glob per side replaces an enumeration:

```json
// container-side pi — everything under extensions/container/
{ "extensions": ["extensions/container/*/src/index.ts"] }
```

```json
// host-side pi — devcontainer and caffeinate, not sbx/gondolin/herdr-worktrees
{ "extensions": ["extensions/host/*/src/index.ts"] }
```

Manifests (the `pi.extensions` array in a package's own `package.json`) also
support glob patterns and `!exclusions` per `docs/packages.md`'s "Creating a
Pi Package" section — but this repo's own manifest keeps listing explicit
entry files rather than a glob, since it needs to name exactly five paths out
of eight packages (the three `shared/` libraries are never `-e`-loadable).

---

## `extensions/host/devcontainer`

A pi coding-agent extension that runs `pi` on the **host** and routes its
built-in filesystem/shell tools (`read`, `write`, `edit`, `bash`, `grep`,
`find`, `ls`) into a **devcontainer** via the `devc` CLI. Reads and writes
reflect the container's filesystem, so the agent sees in-container edits,
build output, and volume-mounted paths (like `node_modules`) the host can't
see — with no per-operation permission prompts. Bare `!` commands stay on the
host.

**Side: host.** Loaded on a container side, `requireSide` refuses to
register anything — see `extensions/shared/extension-core`.

> **Mutually exclusive with `extensions/vm/sbx` and `extensions/vm/gondolin`.**
> All three override the same tool names (`read`, `write`, `edit`, `bash`,
> `grep`, `find`, `ls`, `read_host`, `list_host_docs`). Pi's tool registry
> silently lets whichever loads _last_ win — the others' routing goes dead
> with no error. Enable only one at a time (see "Package Filtering" above).
> If more than one ends up loaded anyway, each extension detects the others
> at `session_start` and surfaces a loud warning naming them, rather than
> failing silently.

```bash
cd /path/to/project
pi -e /path/to/pi-dev-extensions/extensions/host/devcontainer
```

Its only runtime dependency is Docker — the container lifecycle is driven
in-process through `@devc-tools/core`, with no `devc` binary involved.

It also carries the **`devcontainer_herdr_*` orchestration tools**: with a
`herdr` binary on the machine, a host-side pi can derive a worktree path the
container can actually see, create it, and launch an agent inside the
container into a new Herdr pane. They register only when Herdr resolves, they
override nothing, and they add no requirement beyond Docker and Node. Note
they are the **host**-side mirror of `extensions/container/herdr-worktrees`'
container-side `herdr_devc_*` tools, not the same thing. See
[`extensions/host/devcontainer/README.md`](extensions/host/devcontainer/README.md)
for details and `npm run typecheck` / `npm test`.

---

## `extensions/vm/sbx`

A pi coding-agent extension with the same shape as `extensions/host/devcontainer`
above — it routes pi's built-in filesystem/shell tools (`read`, `write`,
`edit`, `bash`, `grep`, `find`, `ls`) into an isolated environment with no
per-operation permission prompts — but the isolation boundary is a **Docker
Sandboxes** (`sbx`) sandbox instead of a devcontainer. It is a separate
extension (not a mode of `extensions/host/devcontainer`) because the two
backends' lifecycle, path model, and mount-inspection primitives differ
enough to make branching one extension on backend more confusing than
maintaining two. Because `sbx` mounts the workspace at the same path as the
host (an identity mount), there is no path-remapping layer here at all,
unlike devcontainer's `remoteWorkspaceFolder` translation. Bare `!` commands
stay on the host.

**Side: host.** `vm/` names what this routes *into*, not where it runs — see
the group note above. Loaded on a container side, `requireSide` refuses to
register anything.

> **Mutually exclusive with `extensions/host/devcontainer` and
> `extensions/vm/gondolin`** — see that section's note above; it applies
> symmetrically here.

```bash
cd /path/to/project
pi -e /path/to/pi-dev-extensions/extensions/vm/sbx
```

Its only runtime dependency is the `sbx` binary on `PATH` — always invoked
from `PATH`, with no override (unlike the devcontainer extension, `sbx` is
driven as an external Docker Desktop binary, not as a library). See
[`extensions/vm/sbx/README.md`](extensions/vm/sbx/README.md) for details, including
the CLI-flag assumptions this extension makes (drawn from `docs.docker.com`,
not a live binary — flagged there for verification), and `npm run typecheck`
/ `npm test`.

---

## `extensions/vm/gondolin`

A pi coding-agent extension with the same shape as `extensions/host/devcontainer`
and `extensions/vm/sbx` above — it routes pi's built-in filesystem/shell tools
(`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) into an isolated
environment with no per-operation permission prompts — but the isolation
boundary is a local [gondolin](https://github.com/earendil-works/gondolin)
micro-VM this extension itself starts and stops, rather than infrastructure
managed by an external `devc`/`sbx` CLI. It is a separate extension (not a
mode of either) because gondolin's lifecycle (own, per-session VM vs.
externally-managed long-lived infra), path model, and tool implementation (an
in-process VM API vs. shelling a CLI) differ enough to make branching one
extension on backend more confusing than maintaining a third. Reads/writes
land at a fixed guest workspace root (`/workspace`) the host cwd is mounted
at; `grep`/`find` walk the guest filesystem in JS rather than shelling out to
`rg`, since a fresh gondolin image has no guaranteed userspace beyond
`/bin/sh`. Bare `!` commands stay on the host. Unlike `devcontainer`/`sbx`,
the VM is stopped again at `session_shutdown` — it belongs to the pi session
that started it, not to externally-managed infrastructure.

**Side: host.** `vm/` names what this routes *into*, not where it runs — see
the group note above. Loaded on a container side, `requireSide` refuses to
register anything.

> **Mutually exclusive with `extensions/host/devcontainer` and
> `extensions/vm/sbx`** — see that section's note above; it applies
> symmetrically here.

```bash
cd /path/to/project
pi -e /path/to/pi-dev-extensions/extensions/vm/gondolin
```

Its only runtime dependency is the `@earendil-works/gondolin` package plus
QEMU installed on the host — no `devc`/`sbx` binary involved. See
[`extensions/vm/gondolin/README.md`](extensions/vm/gondolin/README.md) for details,
including its stricter Node.js ≥ 23.6.0 floor, and `npm run typecheck` /
`npm test`.

---

## `extensions/host/caffeinate`

A pi coding-agent extension that runs macOS's `caffeinate` on the **host**
for exactly as long as an agent run is active — preventing idle sleep while
an agent works unattended — and stops it once the agent settles. A footer
status indicator (`caffeinate: ⠋ awake`) shows whether it's currently active;
`/caffeinate` reports the same on demand.

**Side: host.** Loaded on a container side, `requireSide` refuses to
register anything.

```bash
cd /path/to/project
pi -e /path/to/pi-dev-extensions/extensions/host/caffeinate
```

It's independent of `extensions/host/devcontainer` and meant to stack
alongside it (`pi -e ... -e ...`) rather than replace it. macOS-only: on
other platforms it no-ops with a status message instead of failing. See
[`extensions/host/caffeinate/README.md`](extensions/host/caffeinate/README.md)
for details, the `$PI_CAFFEINATE_ARGS` override, and `npm run typecheck` /
`npm test`.

---

## `extensions/container/herdr-worktrees`

A pi coding-agent extension for a pi **orchestrator running inside a
devcontainer**, alongside [`pi-herdr`](https://github.com/AndrewJacop/pi-herdr).
It registers two additive tools — `herdr_devc_worktree_path` (pure: derive
and validate where a worktree would go) and `herdr_devc_worktree_create`
(create it) — that fill the one gap `pi-herdr` leaves for this host's
layout: `herdr worktree create`'s default location comes from Herdr's own
single global `worktrees.directory` root, which cannot express this
repo-set's `<repo>.worktrees/<branch>` sibling convention, so `--path` must
be derived and passed explicitly on every call. More importantly, a `--path`
outside a bind mount is not rejected — Herdr `mkdir -p`s the missing parent
and reports success, producing a checkout that lives only in the container's
writable layer and is invisible to the host. `herdr_devc_worktree_path`'s
`NOT_A_MOUNT` check (reading `/proc/mounts`, not `existsSync`) is what turns
that into a caught error instead of a silent, host-invisible checkout.

**Side: container.** This extension can no longer be loaded on the host at
all — `requireSide` refuses before registering anything. That closes the
defect that motivated this repo's topology split in the first place: this
extension's own mount guard used to be gated on `ResolveDeps.isContainer`
alone, so a host load skipped the guard entirely and reported success for
any path without checking it.

> **Not** part of the `devcontainer`/`sbx`/`gondolin` mutual-exclusion group
> above. Those three run pi on the **host** and override built-in tools to
> route them **into** an isolated environment; this extension runs as part
> of a pi already **inside** one and registers two new tools, overriding
> nothing. See its own README for the full reasoning.

```bash
# inside a devcontainer, in a Herdr pane
pi -e /path/to/pi-dev-extensions/extensions/container/herdr-worktrees -e <path-to-pi-herdr>
```

Its only runtime dependency is the `herdr` binary (resolved via
`HERDR_BIN_PATH` -> `HERDR_BIN` -> `PATH` -> bare `herdr`) — no code
dependency on `pi-herdr` itself, by design. See
[`extensions/container/herdr-worktrees/README.md`](extensions/container/herdr-worktrees/README.md)
for the full path rule, the tool contracts, and `npm run typecheck` / `npm
test` (offline, fixture-driven — no Herdr server needed). The end-to-end
workflow (starting Herdr, the orchestrator, and a worked
create-and-delegate example) lives in `devc-dev`'s
`docs/orchestrator-workflow.md`.

---

## `extensions/shared/extension-core`

A **shared library**, not a pi extension — it has no `pi.extensions` field and
is never loaded directly via `pi -e`. Holds the `requireSide` guard every
extension above starts with (see § Package layout's `shared/` rule) plus
generic `okResult`/`errorResult` tool-result helpers used across several
extensions. Consumed via an npm `file:` dependency
(`"pi-extension-core": "file:../../shared/extension-core"`) by every loadable
extension in this repo.

See [`extensions/shared/extension-core/README.md`](extensions/shared/extension-core/README.md)
for the `Side`/`SideProbe`/`requireSide` contract.

---

## `extensions/shared/herdr-core`

A **shared library**, not a pi extension — it has no `pi.extensions` field and
is never loaded directly via `pi -e`. It holds what both Herdr tool families
need: `herdr` binary resolution, the `runHerdr` JSON-envelope wrapper, the
`herdr worktree create` argv builder and response normalizer, and the
`<repo>.worktrees/<slug>` path derivation. Consumed via an npm `file:`
dependency (`"pi-extension-herdr-core": "file:../../shared/herdr-core"`) by
`extensions/container/herdr-worktrees` (container-side) and
`extensions/host/devcontainer` (host-side).

The derivation is shared precisely because it is identical on both sides of
the container boundary; the **guards** are not, and they stay in the two
consumers. Like the rest of this repo's Herdr code it deliberately does not
depend on `pi-herdr` — both wrap the same CLI, not each other.

---

## `extensions/shared/host-read-core`

A **shared library**, not a pi extension — it has no `pi.extensions` field
and is never loaded directly via `pi -e`; it's consumed only by `import` from
other `extensions/*/*` packages. It provides the backend-agnostic half of the
`read_host`/`list_host_docs` escape hatch (the per-hop symlink-safe mount
barrier and the two tool factories) so `extensions/host/devcontainer`,
`extensions/vm/sbx`, and `extensions/vm/gondolin` share the exact same
implementation instead of each duplicating it, consumed via an npm `file:`
dependency
(`"pi-extension-host-read-core": "file:../../shared/host-read-core"`). See
[`extensions/shared/host-read-core/README.md`](extensions/shared/host-read-core/README.md)
for the `getMounts` contract each consumer must supply and `npm run
typecheck` / `npm test`.

---

## Development

```bash
npm install         # installs and links all eight packages
npm run typecheck --workspace=extensions/<group>/<name>
npm test --workspace=extensions/<group>/<name>
```

Each package can also be developed standalone from within its own folder
(`cd extensions/<group>/<name> && npm run typecheck`).
