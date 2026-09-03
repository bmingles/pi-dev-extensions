# pi herdr-core

A **shared library**, not a pi extension — it has no `pi.extensions` field and
is never loaded directly via `pi -e`. It lives under `extensions/shared/`
because it is side-agnostic *by construction*, not by luck — see the root
README's `shared/` rule: something lives there only if it doesn't need to
know which side of the container boundary it's on. It is consumed only by
`import` from other `extensions/*/*` packages, via an npm `file:` dependency:

```json
"pi-extension-herdr-core": "file:../../shared/herdr-core"
```

## Why it exists

Two extensions in this repo drive the `herdr` CLI, from **opposite sides of the
container boundary**:

| | [`extensions/container/herdr-worktrees`](../../container/herdr-worktrees) | [`extensions/host/devcontainer`](../../host/devcontainer) |
| --- | --- | --- |
| pi and Herdr run | **inside** the container | on the **host** |
| Tool prefix | `herdr_devc_*` | `devcontainer_herdr_*` |
| Guard | is `<repo>.worktrees` itself a mountpoint (`/proc/mounts`)? → `NOT_A_MOUNT` | is the host path covered by a bind mount of the container (`docker inspect`)? → `NOT_MOUNTED_IN_CONTAINER` |

They wrap the same binary, so the binary resolution, the JSON envelope, the
argv builders and the path derivation are the same code. Only the **guards**
differ, and those stay in the two consumers.

## What it exports

| Module | Exports |
| --- | --- |
| `herdr-bin.ts` | `resolveHerdrBin` — `HERDR_BIN_PATH` → `HERDR_BIN` → a `PATH` walk → the bare name `herdr` |
| `herdr-cli.ts` | `runHerdr`, `HerdrResult`, `HerdrOk`, `HerdrErr`, `RunHerdrOpts` |
| `worktree-create.ts` | `createWorktreeArgs`, `CreateWorktreeArgsOpts`, `extractWorktree`, `NormalizedWorktree` |
| `worktree-layout.ts` | `slugify`, `deriveWorktreeLayout`, `WorktreeLayout` |
| `tilde.ts` | `expandTilde` — both sides take path parameters from a model, and neither has a shell in the loop to expand `~` |

`okResult`/`errorResult`/`ToolResultWithError` moved to
[`extensions/shared/extension-core`](../extension-core) — they're generic pi
tool-result helpers with nothing Herdr-specific about them, so they no longer
live here.

### The one place a bare `path` is correct

Everything in this repo that crosses the host/container boundary names which
side it is on — `hostPath` and `containerPath`, never a bare `path`.
`WorktreeLayout.path` is the exception, deliberately: inside this package the
derivation is side-agnostic, and the *caller* labels the result. The host-side
consumer calls it `hostPath`; the container-side one treats it as a container
path.

## Not a `pi-herdr` dependency

Deliberately. `pi-herdr` is a vendor-neutral, general-purpose Herdr
integration; this is a small set of primitives for two host-specific
extensions. Both call the same `herdr` binary directly — a code dependency
would only couple this repo to a third-party release cadence for no gain. The
reasoning is stated at length in
[`../../container/herdr-worktrees/README.md`](../../container/herdr-worktrees/README.md).

## Development

Part of the repo-root npm workspace — `npm install` here works standalone, but
a single `npm install` from the repo root covers every package at once.

```bash
npm run typecheck  # tsc --noEmit
npm test           # node --test — pure, offline, no Herdr binary needed
```
