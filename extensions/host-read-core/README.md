# `pi-extension-host-read-core`

A **shared library**, not a pi extension — it has no `pi.extensions` entry
and is never the target of `pi -e`. It exists so two devcontainer/sandbox-style
pi extensions can share the exact same `read_host` / `list_host_docs`
machinery instead of duplicating it:

- **[`extensions/devcontainer`](../devcontainer)** — routes tools into a
  devcontainer via `devc`
- **`extensions/sbx`** (Phase 31) — routes tools into a Docker Sandboxes
  (`sbx`) sandbox

## What's in here

- **`resolve-host.ts`** — the per-hop, symlink-safe host-path canonicalizer
  with a mount barrier (`resolveHostPath`, `isInside`). See the file's own
  header comment for the security invariant and the attack matrix
  (`resolve-host.test.ts`) it defends against.
- **`host-read.ts`** — `createReadHostTool` / `createListHostDocsTool`, the
  tool factories that use `resolve-host.ts`'s barrier to implement the two
  host-read tools, plus the `HostReadFs` / `realHostReadFs` filesystem
  surface and the `HostMount` type both tools' deps are expressed in terms
  of.
- **`index.ts`** — re-exports everything a consumer needs from one specifier:
  `import { createReadHostTool, createListHostDocsTool, type HostMount, realHostReadFs, resolveHostPath, isInside } from "pi-extension-host-read-core"`.

## The `getMounts` contract

Both tool factories take a `getMounts: (hostCwd: string) => Promise<HostMount[]>`
dependency, and — unlike this package's own two consumers' historical
default — **it has no default here**. Every consumer must supply its own:

- devcontainer's calls `devc mounts <hostCwd> --json` (a dynamic, N-entry
  table reflecting whatever the container actually has mounted).
- sbx's (Phase 31) is a static one-entry list, since sbx mounts the workspace
  1:1 at `hostCwd` with no dynamic mount table to query.

Defaulting `getMounts` to a devc-specific function would leak a backend
dependency into a package meant to have none — a consumer that forgets to
pass it gets a TypeScript compile error (missing required property on
`ReadHostDeps`/`ListHostDocsDeps`), not a silent fallback to some other
backend's behavior.

## Consuming this package

Add it as a `file:` dependency in the consumer's `package.json`:

```json
{
  "dependencies": {
    "pi-extension-host-read-core": "file:../host-read-core"
  }
}
```

`npm install` inside the consumer resolves `file:../host-read-core` from
local disk (a symlink or copy into `node_modules/`, depending on npm
version) — nothing is published to any registry, and no network access is
required.

Then wire it up (see `extensions/devcontainer/src/index.ts` for the full
pattern):

```ts
import {
  createListHostDocsTool,
  createReadHostTool,
  realHostReadFs,
} from "pi-extension-host-read-core";

const hostReadDeps = {
  getMounts: myBackendSpecificGetMounts,
  fs: realHostReadFs,
  unpromptedDocsPath: getDocsPath(),
};

pi.registerTool(createReadHostTool(hostCwd, hostReadDeps));
pi.registerTool(createListHostDocsTool(hostCwd, hostReadDeps));
```

## `peerDependencies`, not `devDependencies` or `dependencies`

`host-read.ts` calls `defineTool`/`getDocsPath`/`truncateHead`/
`DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES`/`formatSize` (from
`@earendil-works/pi-coding-agent`) and `Type.Object` (from `typebox`) at
*runtime*, not just for types — same as `extensions/devcontainer` and
`extensions/sbx`, which import `create*Tool`/`truncateHead`/etc. from
`@earendil-works/pi-coding-agent` directly. Per pi's own
[`docs/packages.md`](https://github.com/earendil-works) — *"Pi bundles core
packages for extensions and skills. If you import any of these, list them in
`peerDependencies` with a `"*"` range and do not bundle them"* — all three
packages declare `@earendil-works/pi-coding-agent` (and, here, `typebox`) as
**`peerDependencies`**, never `dependencies` or `devDependencies`.

Why this matters: package installs from `pi install`/`pi -e git:...` are
production installs (`npm install --omit=dev`), so anything only in
`devDependencies` never gets installed for a real consumer — the failure mode
is a runtime `Error: Cannot find module '@earendil-works/pi-coding-agent'`
(or `typebox`) from *inside* this package's code, surfacing only when a
consumer imports it, not a compile error in `npm test`/`npm run typecheck`
here, so it's easy to miss. `dependencies` would avoid that failure but
bundle a second, separately-resolved copy alongside whatever pi's own host
process already provides — exactly what "do not bundle them" warns against.
`peerDependencies` with `"*"` avoids both: npm still auto-installs a real,
resolvable copy (verified empirically — even a bare `peerDependencies: "*"`
with no version pinned anywhere else in the graph installs correctly under
`--omit=dev`, standalone or as part of this repo's workspace), while
documenting that the *version* is pi's call, not this package's.
`@earendil-works/pi-coding-agent` itself depends on `typebox`, so
`extensions/devcontainer`/`extensions/sbx` — which use `create*Tool` but
never import `typebox` directly — get it transitively and don't declare it
themselves.

`extensions/caffeinate` is the one exception: it only does
`import type { ExtensionAPI, ExtensionContext }`, which is erased entirely at
build/load time, so it has no runtime dependency on
`@earendil-works/pi-coding-agent` at all — a `devDependency` (for local
`tsc`/`node --test`) is correct and sufficient there.

## Development

Part of the repo-root npm workspace (see the root README's
"Package layout" section) — `npm install` here works standalone,
but a single `npm install` from the repo root covers all four packages at
once.

```bash
npm install        # install pi (types) + typebox + typescript + @types/node
npm run typecheck  # tsc --noEmit against pi's real types
npm test           # node --test (unit tests, fully fake fs/mounts — no devc/docker)
```

This package has no manual smoke test of its own — it has no `pi.extensions`
entry, so it can't be loaded via `pi -e` directly. Exercise it through a
consumer (`extensions/devcontainer`'s own smoke test).
