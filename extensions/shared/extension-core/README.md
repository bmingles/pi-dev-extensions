# pi-extension-core

A **shared library**, not a pi extension — it has no `pi.extensions` field
and is never loaded directly via `pi -e`. It holds plumbing every extension
in this repo needs regardless of which side it runs on or what it's about —
the `shared/` rule from the root README: something lives here only if it is
side-agnostic *by nature*. Contrast with
[`herdr-core`](../herdr-core) (Herdr CLI plumbing, needed by two of the
extensions) and [`host-read-core`](../host-read-core) (the host-read barrier,
needed by three) — both are shared because multiple extensions happen to need
the same subject-specific thing, not because they're subject-agnostic the way
this package is.

## What it exports

| Module | Exports |
| --- | --- |
| `side.ts` | `Side`, `SideProbe`, `realSideProbe`, `detectSide`, `requireSide` — the host/container guard every loadable extension starts with |
| `tool-result.ts` | `okResult`, `errorResult`, `ToolResultWithError` — generic pi tool-result helpers, moved here from `herdr-core` since they have nothing Herdr-specific about them |

## `requireSide` — the side guard

`pi-dev-extensions` splits its extensions by which side of the container
boundary they run on: `extensions/host/*` and `extensions/vm/*` run on the
**host**; `extensions/container/*` runs **inside** a container. Every
loadable extension's factory starts with:

```ts
export default function (pi: ExtensionAPI) {
  if (!requireSide("host", pi, "devcontainer")) return;   // or "container"
  …
}
```

A wrong-side load refuses **loudly** — zero tools register, and a
`session_start` notification names the extension, the side it needed, and the
side it found — rather than half-working. This is not the same question as
`extensions/host/devcontainer`'s `ROUTING_MARKER_KEY` check (two *valid*
routing extensions both loaded at once, which warns and carries on):
`requireSide` is about an extension that cannot function on this side at all.

Detection is `/.dockerenv` — the same signal `herdr-worktrees`' own
`realIsContainer` already used before this package existed. It answers "am I
in a container", not "am I in *the* devcontainer"; do not confuse it with
`extensions/host/devcontainer`'s `ensureContainer`, which resolves a
*specific* container via `docker inspect`.

`detectSide`/`requireSide` both take an optional `SideProbe` so they (and any
factory that forwards one through) are testable without a real container —
see `side.test.ts` and the `index.test.ts` in each side-declaring extension.

## Consuming this package

```json
{
  "dependencies": {
    "pi-extension-core": "file:../../shared/extension-core"
  }
}
```

## Development

Part of the repo-root npm workspace — `npm install` here works standalone,
but a single `npm install` from the repo root covers all eight packages at
once.

```bash
npm run typecheck  # tsc --noEmit
npm test           # node --test — pure, offline, no container needed
```
