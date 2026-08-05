# pi-dev-extensions

A [pi](https://github.com/earendil-works) coding-agent package bundling four
Node/TypeScript extensions for routing pi's tools through an isolated dev
environment, plus keeping the host machine awake while pi works unattended:

- **[`extensions/devcontainer`](#extensionsdevcontainer)** — routes pi's
  built-in tools into a devcontainer via `devc`
- **[`extensions/sbx`](#extensionssbx)** — routes pi's built-in tools into a
  Docker Sandboxes (`sbx`) sandbox instead of a devcontainer
- **[`extensions/caffeinate`](#extensionscaffeinate)** — keeps the Mac awake
  (`caffeinate`) while an agent run is active
- **[`extensions/host-read-core`](#extensionshost-read-core)** — a shared
  library (not independently `pi -e`-loadable) providing the
  `read_host`/`list_host_docs` tool machinery consumed by `devcontainer` and
  `sbx`

## Requirements

- Node.js ≥ 26.5.0 (see `.nvmrc`) — all four packages use native `.ts`
  type-stripping, no build step
- `devc` on `PATH` for `extensions/devcontainer`; `sbx` on `PATH` for
  `extensions/sbx` (see each package's README)

## Shell setup

`scripts/bash_aliases_pic.sh` defines `pic` — `pi` launched with the
`caffeinate` and `devcontainer` extensions loaded, by absolute path, so it
works from any directory. Source it from your `~/.bashrc` or `~/.zshrc`:

```bash
source /path/to/pi-dev-extensions/scripts/bash_aliases_pic.sh
```

It has no knowledge of where `devc` comes from — the `devcontainer`
extension invokes plain `devc` on `PATH` by default. If you run `devc` from
source (e.g. from an `agent-tools` checkout) rather than a compiled binary,
export `$DEVC_BIN` yourself; see
[`extensions/devcontainer/README.md`](extensions/devcontainer/README.md).

## Package layout

This repo follows pi's own [package conventions](https://github.com/earendil-works)
(`docs/packages.md`): a package can declare its resources in `package.json`
under the `pi` key, and pi auto-discovers a top-level `extensions/` directory.
Each subfolder here is an independently loadable extension (or, for
`host-read-core`, a shared library consumed only via `import`) with its own
`package.json`, `src/`, and tests.

The repo root's `package.json` does double duty:

- It's a bare pi package manifest — `keywords: ["pi-package"]` + a
  `pi.extensions` array listing each loadable extension's entry file
  (`host-read-core` is never listed — it's a library, not `-e`-loadable).
  This is what `pi install`/`pi -e` look for.
- It's also the real npm workspaces root (`"workspaces": ["extensions/*"]`)
  — one `npm install` from repo root hoists and links all four packages
  correctly regardless of order. This is also exactly what `pi install
  git:...`'s own automatic `npm install` step runs, so installing straight
  from GitHub needs no extra manual step.

The only footprint at the true repo root is a gitignored `node_modules/` and
a committed `package-lock.json` (the real, consolidated lockfile for all four
packages) — no source lives there, only `package.json` plus install-time
artifacts.

### Installing straight from GitHub

Per pi's `docs/packages.md`, `pi install git:host/user/repo@ref` (or
`pi -e git:...` to try it without persisting) clones the whole repository,
runs `npm install` at its root (setting up all four packages via the
workspaces root above), and loads whichever paths its `pi.extensions`
manifest lists — **all three by default**. `devcontainer` and `sbx` are
mutually exclusive (see below), so pick one at install time using pi's
package filtering, either via `pi config` after installing, or by writing the
filtered form directly into `.pi/settings.json` up front (pi installs any
package listed there automatically once the project is trusted — no separate
`pi install` step needed):

```json
// .pi/settings.json — enables only extensions/devcontainer
{
  "packages": [
    {
      "source": "git:github.com/<you>/pi-dev-extensions@main",
      "extensions": ["extensions/devcontainer/src/index.ts"]
    }
  ]
}
```

Swap the one `extensions` entry for `"extensions/sbx/src/index.ts"` to get
`sbx` instead.

---

## `extensions/devcontainer`

A pi coding-agent extension that runs `pi` on the **host** and routes its
built-in filesystem/shell tools (`read`, `write`, `edit`, `bash`, `grep`,
`find`, `ls`) into a **devcontainer** via the `devc` CLI. Reads and writes
reflect the container's filesystem, so the agent sees in-container edits,
build output, and volume-mounted paths (like `node_modules`) the host can't
see — with no per-operation permission prompts. Bare `!` commands stay on the
host.

> **Mutually exclusive with `extensions/sbx`.** Both override the same tool
> names (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `read_host`,
> `list_host_docs`). Pi's tool registry silently lets whichever loads *last*
> win — the other's routing goes dead with no error. Enable only one at a
> time (see "Package Filtering" above). If both end up loaded anyway, each
> extension detects the other at `session_start` and surfaces a loud warning
> naming both, rather than failing silently.

```bash
cd /path/to/project
pi -e /path/to/pi-dev-extensions/extensions/devcontainer
```

Its only runtime dependency is the `devc` binary on `PATH`. See
[`extensions/devcontainer/README.md`](extensions/devcontainer/README.md) for
details and `npm run typecheck` / `npm test`.

---

## `extensions/sbx`

A pi coding-agent extension with the same shape as `extensions/devcontainer`
above — it routes pi's built-in filesystem/shell tools (`read`, `write`,
`edit`, `bash`, `grep`, `find`, `ls`) into an isolated environment with no
per-operation permission prompts — but the isolation boundary is a **Docker
Sandboxes** (`sbx`) sandbox instead of a devcontainer. It is a separate
extension (not a mode of `extensions/devcontainer`) because the two backends'
lifecycle, path model, and mount-inspection primitives differ enough to make
branching one extension on backend more confusing than maintaining two.
Because `sbx` mounts the workspace at the same path as the host (an identity
mount), there is no path-remapping layer here at all, unlike devcontainer's
`remoteWorkspaceFolder` translation. Bare `!` commands stay on the host.

> **Mutually exclusive with `extensions/devcontainer`** — see that section's
> note above; it applies symmetrically here.

```bash
cd /path/to/project
pi -e /path/to/pi-dev-extensions/extensions/sbx
```

Its only runtime dependency is the `sbx` binary on `PATH` — always invoked
from `PATH`, no `$DEVC_BIN`-style override (unlike `devc`, `sbx` is purely an
external Docker Desktop binary). See
[`extensions/sbx/README.md`](extensions/sbx/README.md) for details, including
the CLI-flag assumptions this extension makes (drawn from `docs.docker.com`,
not a live binary — flagged there for verification), and `npm run typecheck`
/ `npm test`.

---

## `extensions/caffeinate`

A pi coding-agent extension that runs macOS's `caffeinate` on the **host**
for exactly as long as an agent run is active — preventing idle sleep while
an agent works unattended — and stops it once the agent settles. A footer
status indicator (`caffeinate: ⠋ awake`) shows whether it's currently active;
`/caffeinate` reports the same on demand.

```bash
cd /path/to/project
pi -e /path/to/pi-dev-extensions/extensions/caffeinate
```

It's independent of `extensions/devcontainer` and meant to stack alongside it
(`pi -e ... -e ...`) rather than replace it. macOS-only: on other platforms
it no-ops with a status message instead of failing. See
[`extensions/caffeinate/README.md`](extensions/caffeinate/README.md) for
details, the `$PI_CAFFEINATE_ARGS` override, and `npm run typecheck` /
`npm test`.

---

## `extensions/host-read-core`

A **shared library**, not a pi extension — it has no `pi.extensions` field
and is never loaded directly via `pi -e`; it's consumed only by `import` from
other `extensions/*` packages. It provides the backend-agnostic half of the
`read_host`/`list_host_docs` escape hatch (the per-hop symlink-safe mount
barrier and the two tool factories) so `extensions/devcontainer` and
`extensions/sbx` share the exact same implementation instead of each
duplicating it, consumed via an npm `file:` dependency
(`"pi-extension-host-read-core": "file:../host-read-core"`). See
[`extensions/host-read-core/README.md`](extensions/host-read-core/README.md)
for the `getMounts` contract each consumer must supply and `npm run
typecheck` / `npm test`.

---

## Development

```bash
npm install         # installs and links all four packages
npm run typecheck --workspace=extensions/<name>
npm test --workspace=extensions/<name>
```

Each package can also be developed standalone from within its own folder
(`cd extensions/<name> && npm run typecheck`).
