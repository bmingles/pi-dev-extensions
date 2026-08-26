# Plan Status

## Ready to Implement

_(none)_

## Not Ready

_(none)_

## Completed

| Plan | Status | Summary |
| --- | --- | --- |
| [devcontainer-extension-on-devc-core](implemented/devcontainer-extension-on-devc-core.md) | ✅ Done | `extensions/devcontainer` no longer spawns a `devc` binary: it starts and inspects the container in-process through `@devc-tools/core` and runs routed commands via `docker exec` argv built by core's `buildExecArgs`. `$DEVC_BIN` is gone; the runtime prerequisites are Docker and Node. Core's output is kept off pi's TUI by `setLogger` plus `createNodeDevcontainerRunner({ onStderr })`, buffered and appended to the error on a failed start. 38 tests (up from 34), all five workspace packages green. `@devc-tools/core@0.1.0` is published and the committed lockfile resolves it from the registry, so a from-clean `npm install` works. The Docker- and pi-dependent validation items could not run in the dev environment; they were validated by the author in a real session after the publish. |
