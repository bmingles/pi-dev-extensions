# Plan Status

## Ready to Implement

_(none)_

## Not Ready

_(none)_

## Completed

| Plan | Status | Summary |
| --- | --- | --- |
| [devcontainer-extension-on-devc-core](implemented/devcontainer-extension-on-devc-core.md) | ✅ Done | `extensions/devcontainer` no longer spawns a `devc` binary: it starts and inspects the container in-process through `@devc-tools/core` and runs routed commands via `docker exec` argv built by core's `buildExecArgs`. `$DEVC_BIN` is gone; the runtime prerequisites are Docker and Node. Core's output is kept off pi's TUI by `setLogger` plus `createNodeDevcontainerRunner({ onStderr })`, buffered and appended to the error on a failed start. 38 tests (up from 34), all five workspace packages green. **One item deliberately open:** `@devc-tools/core` is unpublished, so `package.json` carries the intended exact `0.1.0` but the lockfile is the pre-change one and a from-clean `npm install` fails until the publish. The Docker- and pi-dependent validation items are unrun and marked as such. |
