# pi herdr-worktrees extension

A [pi](https://github.com/earendil-works) coding-agent extension for a pi
**orchestrator running INSIDE a devcontainer**, alongside
[`pi-herdr`](https://github.com/AndrewJacop/pi-herdr). It closes the one gap
`pi-herdr` leaves for this host's layout: deriving a safe `--path` for
`herdr worktree create` under the devcontainer's `<repo>.worktrees/<branch>`
sibling convention, and refusing to create one that Herdr would silently
place outside a bind mount.

## Why this is a separate extension, not part of `pi-herdr`

`pi-herdr` is a vendor-neutral, general-purpose Herdr integration. This
extension encodes one host-specific fact — that repos here keep worktrees in
a sibling `<repo>.worktrees/` directory, bind-mounted from the host, rather
than under Herdr's own global `worktrees.directory` root — plus the guard
that fact requires. Neither belongs in `pi-herdr`, and this extension does
not depend on it: both call the same `herdr` binary directly, so a code
dependency would only couple this package to a third-party release cadence
for no gain. Load both together (`pi -e ... -e ...`); the `herdr_` vs.
`herdr_devc_` name prefixes keep their tools distinguishable in a tool list.

## ⚠️ `herdr_devc_*` (here) vs. `devcontainer_herdr_*` (in `extensions/devcontainer`)

Two mirror-image tool families now exist in this repo, and they serve
**opposite topologies**:

| | `herdr_devc_*` (this extension) | `devcontainer_herdr_*` ([`extensions/devcontainer`](../devcontainer)) |
| --- | --- | --- |
| pi runs | **inside** the container | on the **host** |
| Herdr runs | inside the container | on the **host** |
| The guard asks | is `<repo>.worktrees` itself a mountpoint, per `/proc/mounts`? | is the derived **host** path covered by a bind mount of the target container, per `docker inspect`? |
| Failure code | `NOT_A_MOUNT` | `NOT_MOUNTED_IN_CONTAINER` |
| Paths | container paths only — a container cannot derive a host path at all | both, always named `hostPath` / `containerPath` |

The two can never load in one process, but the codes and prefixes are
deliberately distinct strings so that a reader grepping for one does not find
the other.

## Shared plumbing lives in `extensions/herdr-core`

The pieces both families need — `resolveHerdrBin`, `runHerdr`, the
`okResult`/`errorResult` helpers, `createWorktreeArgs`/`extractWorktree`, and
the `<repo>.worktrees/<slug>` derivation (`slugify`, `deriveWorktreeLayout`),
and `expandTilde` —
live in [`pi-extension-herdr-core`](../herdr-core), a private library package
with no `pi.extensions` key. Only the **guard** differs between the two
topologies, so only the guard stayed here, in `src/worktree-path.ts`.

## Why this is NOT in the `devcontainer`/`sbx`/`gondolin` mutual-exclusion group

Those three extensions run pi **on the host** and override pi's built-in
tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `read_host`,
`list_host_docs`) to route them **into** an isolated environment. This
extension is the opposite shape entirely: it runs as part of a pi that is
already **inside** the devcontainer, and it registers two new, additive
tools — it overrides nothing. There is nothing to conflict over, so it can
be loaded regardless of which (if any) of those three is active on some
other, host-side pi. (It only makes sense to load in the container that
`devcontainer`/`sbx` would route into in the first place — see
`devc-dev/docs/orchestrator-workflow.md` for the actual usage flow.)

## What it registers

Two tools, both under the `herdr_devc_` prefix (never `herdr_worktree_*`,
which is `pi-herdr`'s own):

### `herdr_devc_worktree_path`

Pure — resolves the repo root (`git rev-parse --show-toplevel`) and derives
where a worktree would go, but creates nothing and never calls `herdr`.
Exists so a caller (or a human, via `/herdr_devc_worktree_path` from pi, or
just reading its description) can ask "where would this go, and is that
safe?" before committing to a create.

The path rule, stated once so the tool and the sibling skill agree:

```
repoRoot     = git rev-parse --show-toplevel   (from `repo`, or cwd)
repoName     = basename(repoRoot)
worktreesDir = dirname(repoRoot) + "/" + repoName + ".worktrees"
path         = worktreesDir + "/" + slug(branch)
```

`slug()`: lowercase, `/` and anything outside `[a-z0-9._-]` replaced with
`-`, runs collapsed, leading/trailing `-` trimmed — `feature/foo_bar` ->
`feature-foo_bar`. Deliberately does not try to match Herdr's own
branch-slug rule, which only applies under `worktrees.directory`, the
layout this extension never uses.

Returns one of:

| Result | Meaning |
| --- | --- |
| ok: `{ repoRoot, repoName, worktreesDir, path, branch, slug, mounted: true }` | Safe to create. `path` is normalized (no `..`). |
| `NOT_A_REPO` | No git repo found at/above the given `repo` (or cwd). |
| `NOT_A_MOUNT` | **The point of this tool.** `worktreesDir` is not itself a bind mount (checked by reading `/proc/mounts`, not `existsSync` — Herdr `mkdir -p`s a missing parent and reports success, so an existence check would pass right through the hazard). Only checked inside a container (`/.dockerenv` present); on a bare host every path is "mounted" by definition, so the check is skipped there. The message names the directory and says to add a mount via `devc config` (`.devc/devc.jsonc`). |
| `PATH_EXISTS` | The target directory already exists. |

### `herdr_devc_worktree_create`

Resolves via the same logic as `herdr_devc_worktree_path` — any error is
returned **unchanged**, and nothing is created when the guard fires — then
runs:

```
herdr worktree create --cwd <repoRoot> --branch <branch> --path <path> \
  [--base <base>] --label <label> [--focus|--no-focus] --json
```

`--path` is always passed explicitly: Herdr's `worktrees.directory` composes
`<root>/<repo>/<branch-slug>` under one single global root and has no
setting that can express this host's `<repo>.worktrees/<branch>` sibling
layout, so relying on the default would create the wrong thing, not a
merely-suboptimal one. `--no-focus` is the default — background work must
not steal the human's focus, the same rule the bundled `herdr` skill states
— and `label` defaults to `<repoName>:<branch>` when not given.

Returns `{ path, branch, label, openWorkspaceId, repoRoot }` on success. Note
that `label` in the response is always the label this tool computed or was
given, **not** whatever Herdr's own `worktree.label` field echoes back —
verified live that field is Herdr's own per-repo default (`== repoName`) and
unrelated to the `--label` just passed for the workspace; trusting it would
silently discard the caller's label.

`worktrees.directory` itself is never touched by this extension — Herdr's
global config stays exactly as the user left it.

## What this extension does not do

- **Does not override any built-in tool** (see above).
- **Does not depend on `pi-herdr`** — reimplements the small pieces it needs
  (an argv builder, a tolerant response normalizer, `herdr` binary
  resolution) independently, deliberately mirroring `pi-herdr`'s own
  `src/tools/worktrees.ts` patterns rather than importing them.
- **Does not set `worktrees.directory`.**
- **Does not translate host <-> container paths.** Every path this
  extension produces or consumes is a **container path**. A container
  cannot derive a host path from `/proc/mounts` — the bind source it reports
  is something like `/run/host_mark/Users`, not the host path that was
  actually mounted — so this module doesn't try. Nothing in the topology
  this extension serves needs one.

## Herdr binary resolution

`HERDR_BIN_PATH` -> `HERDR_BIN` -> a `PATH` walk -> the bare name `herdr`.
`HERDR_BIN_PATH` is set in every Herdr pane (including the orchestrator's
own) and is checked first because it can't be shadowed by an unrelated
`herdr` earlier on `PATH` and needs no manual setup, unlike `HERDR_BIN`.

## Usage

```bash
# inside a devcontainer, in a Herdr pane
pi -e /path/to/pi-dev-extensions/extensions/herdr-worktrees -e <path-to-pi-herdr>
```

See `devc-dev`'s `docs/orchestrator-workflow.md` and the
`herdr-devcontainer-worktrees` skill (cross-referenced from there) for the
full end-to-end workflow: attaching, starting Herdr, starting the
orchestrator, and a worked create-and-delegate example.

## Development

```bash
npm install        # from the repo root — hoists/links all packages
npm run typecheck  # tsc --noEmit against pi's real types
npm test           # node --test — offline, no Herdr server, no pi
```

Tests run entirely against fixtures (an injected `/proc/mounts` fixture, a
fake `git rev-parse`, a fake `existsSync`) — no server, no pi, no real
container. `src/worktree-path.ts` is deliberately its own module, separate
from the tool handlers in `src/tools.ts`, so the mount-check logic stays
testable exactly that way. `src/real-deps.ts` is the only place
in this package that touches git, `/proc/mounts`, `/.dockerenv`, or the real
filesystem. The path derivation and the Herdr CLI plumbing moved to
[`herdr-core`](../herdr-core), and their tests moved with them.

A real end-to-end check (verified manually while building this extension,
against Herdr 0.8.2) also exists but isn't part of `npm test`, since it
needs a running Herdr server and creates a real worktree: resolve a path
against a repo that actually has a `.worktrees` mount, then run the create
argv through `runHerdr` for real, and confirm both the returned `path` and
`git worktree list` in the source repo agree, and that the checkout's `.git`
file and the source repo's `.git/worktrees/<branch>/gitdir` are both
relative (the property the whole devcontainer topology rests on). Clean up
afterward with `git worktree remove --force` plus `git branch -D` — this
touches a real branch in a real repo, never a repo you don't intend to leave
a branch in.
