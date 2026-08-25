# `extensions/devcontainer` consumes `@devc-tools/core` instead of the `devc` binary

The extension stops spawning a `devc` binary and calls devc's lifecycle logic
in-process, as the npm library that
[`devc-core-npm-library`](https://github.com/emeraldwalk/devc-tools/blob/main/.plans/archived/devc-core-npm-library.md)
(devc-tools repo, archived/implemented) exists to provide. `devc up --json`
becomes `startContainer(hostCwd)` returning a `ContainerInfo` value; `devc
mounts --json` becomes `getContainerMounts(hostCwd)`; `devc exec` becomes a
`docker exec` argv built by core's `buildExecArgs` and spawned by the
extension's own driver.

After this, the extension's runtime prerequisites are **Docker and Node** —
no `devc` on `PATH`, no `$DEVC_BIN`, no stdout parsing, no version skew
between a binary someone installed months ago and the extension that shells
out to it.

## Is the unpublished package a blocker?

**Only for the last line of `package.json`, and only for other people.** Every
other step is implementable and testable today:

- `npm pack` in `devc-tools/devc-core/` produces a tarball; `npm i
  ../devc-tools/devc-core/devc-tools-core-0.1.0.tgz` (or a `file:` dep) puts a
  real, resolvable `@devc-tools/core` in this workspace's `node_modules` with
  the exact `dist/mod.js` + `dist/mod.d.ts` that publishing would ship.
- All of `typecheck` and `node --test` run green against that.
- The only thing the tarball can't give is a `package.json` line other clones
  can install. So: do the work against the tarball, and make **flipping the
  dependency spec to `"@devc-tools/core": "0.1.0"` the final checklist item**,
  gated on the publish. Do not commit a `file:` or `.tgz` path.

Nothing else in this plan waits on npm.

## Prerequisites in devc-tools

**All prerequisites have landed** — devc-tools `main`, commits `db2b345`,
`c47d5dc`, `aefaae2` (2026-08-24). Recorded here because they are what this
plan's contracts are written against, and because a stale copy of core will not
have them. Nothing below blocks the work any more.

### Landed

1. ~~**Settle and claim the package name.**~~ **Done** — the `devc-tools` org
   is claimed on npm, so `@devc-tools/core` is the specifier. No fallback to
   an unscoped `devc-core` is needed.
2. ~~**`~/.cache/devc/default` gets clobbered by whichever copy of core ran
   last.**~~ **Done.** The zero-config cache is now content-addressed —
   `~/.cache/devc/default-<key>/`, keyed on the bundled `default/` tree, the
   user's `templates/` overlay and the bridge flag — staged in a sibling
   `.tmp-…/` and `rename`d into place. Two copies of core cannot rewrite each
   other's config, and no start observes a half-written tree. A cache hit
   writes nothing at all, so it is also cheaper than what it replaced.

   One correction to what this section originally claimed, since it changes
   what to expect while testing: the version-skew case was described as causing
   "rebuild churn from nothing the user did". That was overstated.
   `startContainer` materializes immediately before it runs `devcontainer up`,
   so sequential use was always self-correcting. The real defect was the
   **concurrency race**, which a long-running pi session is exactly what makes
   reachable. Two copies with genuinely different bundled trees still produce
   different configs and still rebuild when you alternate them — that is
   correct, and content-addressing neither causes nor prevents it.

   Related, and worth knowing before the first run: changing a workspace's
   config path **orphans** the old container rather than replacing it. The
   devcontainer CLI keys on `devcontainer.local_folder` *and*
   `devcontainer.config_file`, rejects a `local_folder` match whose
   `config_file` differs, and only ever removes a container carrying no
   `config_file` label. `devc` now detects that same-workspace duplicate and
   prints the `docker rm -f <id>` that clears it.

3. ~~**A log seam.**~~ **Done**, though not as a `StartOptions` field — core's
   seven print sites sit in three modules at varying depths, several inside
   otherwise-pure helpers that no `StartOptions` reaches. It is a module-level
   sink instead: `setLogger(logger | null)` plus `logNotice` / `logWarning`,
   defaulting to `console.log` / `console.error` so `devc`'s own stdout/stderr
   split is byte-identical. **This deletes the console monkey-patch this plan
   used to carry.**
4. ~~**Export `devcontainerJsPath()`.**~~ **Done**, and better: core now
   exports `createNodeDevcontainerRunner({ onStderr })`, which pipes the
   devcontainer CLI's stderr to a callback instead of the terminal.
   `nodeDevcontainerRunner` remains the no-options instance. **This deletes the
   hand-rolled `DevcontainerRunner` and the `createRequire` path derivation.**
   `devcontainerJsPath()` is exported too, but nothing here needs it now.

### Cheap polish — also done

5. `devc-core/LICENSE` now ships in the tarball.
6. `package.json` has a `repository` field.

### Verified fine — no action needed

- **Safe to load in-process:** no `process.exit`, no signal handlers, no
  `process.chdir`, no env mutation anywhere in core.
- **Types are clean** against this extension's exact tsconfig (NodeNext +
  `verbatimModuleSyntax` + `allowImportingTsExtensions`) — `tsc --noEmit`
  passes on the full consumer surface this plan uses.
- **`dist/default/` resolves from an installed tarball under plain Node.**
  `copyBundledAssets` wrote all ten files correctly. The original devc-core
  plan only proved this for the `deno compile` VFS; it holds for npm too.
- **`buildExecArgs` output is as expected:** `exec -i -e A=1 -u vscode -w /w
  abc cat -- /w/f`.
- **No fourth `@devcontainers/cli` pin is needed here** — with
  `createNodeDevcontainerRunner`, the extension never resolves that package at
  all.

## Design decisions

- **`startContainer`, not `execInContainer`.** Core exports
  `execInContainer(localFolder, opts)`, and it looks like the obvious
  replacement for `devc exec`. It is the wrong one, twice over: it calls
  `startContainer` on **every** invocation (the extension resolves the
  container once per session and reuses it), and its `stdio: 'piped'` mode
  returns decoded **strings** with no stdin, no incremental output, no
  `AbortSignal` and no timeout. The routed tools need all four —
  `read.readFile` returns a `Buffer` from `cat` (decoding would corrupt binary
  files), `write.writeFile` pipes content to `tee` on stdin, and `bash.exec`
  streams and cancels. So the extension keeps its existing spawn driver and
  uses core only for the argv: `buildExecArgs(...)` → `spawn("docker", args)`.
- **Keep core's output off the TUI with the two seams core now exports.** In a
  CLI, core printing to `console.*` and letting `devcontainer up` inherit stderr
  is correct. In pi both corrupt the display, and today's subprocess design hid
  it — the extension pipes devc's streams and the terminal never sees them.
  Restore that with:

  ```ts
  setLogger((level, message) => { /* buffer; notify on failure */ });
  const devcontainer = createNodeDevcontainerRunner({ onStderr: collect });
  ```

  `setLogger` once at extension load, and the runner passed as
  `StartOptions.devcontainer`. Both come from `@devc-tools/core`; neither needs
  a `console` patch, a hand-rolled runner, or a `@devcontainers/cli` resolution
  of its own. Buffer what arrives and append it to the error on failure — that
  is what the old code did with the child's captured stderr — and discard it on
  success.

- **Infra failures become thrown errors, and that is an improvement.** `devc
  exec` reserved exit 125 for "devc/docker failed" vs. "the routed command
  failed"; the extension mapped 125 → `DevcInfraError`. With core, a container
  that won't start throws out of `startContainer` directly and never reaches
  the exec path. Keep the 125 mapping anyway — `docker exec` uses 125 for its
  own failures by convention — but it is now a backstop, not the primary
  signal.
- **`src/devc.ts` → `src/container.ts`.** The module no longer wraps a CLI
  called devc; it resolves and drives a container. Renaming keeps the file
  honest and the rename is mechanical (three importers). See Concept
  boundaries for the collision this creates with core's own `container.ts`.
- **`$DEVC_BIN` is deleted, not replaced.** It existed so a from-source devc
  could be used without compiling a binary. There is no binary any more, so
  there is nothing to point it at. Its test, its README paragraphs (this
  extension's and the root's), and the `bash_aliases_devc.sh` advice all go.

## Existing touchpoints

| File | Role after the change |
| --- | --- |
| `extensions/devcontainer/package.json` | gains `@devc-tools/core`; root `package-lock.json` changes with it |
| `extensions/devcontainer/src/devc.ts` → `src/container.ts` | the adapter: `ensureContainer`, `runInContainer`, `getMounts`, and the `setLogger` / `onStderr` wiring. Keeps the spawn driver verbatim |
| `extensions/devcontainer/src/devc.test.ts` → `src/container.test.ts` | argv assertions retarget from `devc …` to `docker exec …`; `$DEVC_BIN` test deleted |
| `extensions/devcontainer/src/index.ts` | imports `ContainerInfo` from core; `devcUp(hostCwd)` → `ensureContainer(hostCwd)`; unchanged otherwise (home-dir gate, spinner, status line, `user_bash`, prompt patch all stay) |
| `extensions/devcontainer/src/tools.ts` | import path only — `./devc.ts` → `./container.ts`, and `ContainerInfo` now re-exported from core. Every `*Operations` body is untouched |
| `extensions/devcontainer/src/tools.test.ts` | import path only |
| `extensions/devcontainer/README.md` | Requirements section: Docker + Node, no `devc`, no `$DEVC_BIN`; Development section notes the npm dep |
| `README.md` (root) | lines 30, 43–50, 135–136: `devc` on `PATH` is no longer a prerequisite |
| `extensions/host-read-core/README.md:33`, `extensions/sbx/README.md:92` | prose mentions of `devc mounts <hostCwd> --json` — reword to "the devcontainer extension's mount table"; no code change |
| `extensions/devcontainer/src/paths.ts`, `extensions/host-read-core/**` | **unchanged** |

## Contract

### `src/container.ts` public surface

```ts
// Re-exported from @devc-tools/core so tools.ts imports one name from one place.
export type { ContainerInfo } from "@devc-tools/core";

/** Unchanged from today — tools.ts depends on these shapes verbatim. */
export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array | string;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface RunResult { code: number; stdout: Uint8Array; stderr: Uint8Array }
export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
export class DevcInfraError extends Error {}

/** Was `devcUp`. Starts/warms the container rooted at `hostCwd`. */
export function ensureContainer(hostCwd: string): Promise<ContainerInfo>;

/** Was `devc mounts --json`. `null` from core (no container) becomes `[]`. */
export function getMounts(hostCwd: string): Promise<HostMount[]>;

/** Signature unchanged; `info` is now required, since the argv needs it. */
export function runInContainer(
  info: ContainerInfo,
  argv: string[],
  opts?: RunOptions,
  spawn?: SpawnFn,
): Promise<RunResult>;
```

`runInContainer` gaining `info` in place of `hostCwd` is the one signature
change that reaches `tools.ts`: `boundRun(hostCwd)` becomes
`boundRun(info)`, and `index.ts`'s single `const run = boundRun(hostCwd)` at
load time moves inside `ensureContainerForTool` (it needs the resolved `info`).
Every `create*Operations(info, hostCwd, run)` call site keeps its arity.

### The argv

```ts
spawn("docker", buildExecArgs({
  containerId: info.containerId,
  remoteUser: info.remoteUser,
  cwd: opts.cwd ?? info.remoteWorkspaceFolder,
  remoteEnv: info.remoteEnv,
  env: opts.env ?? {},
  cmd: argv,
}), { stdio: ["pipe", "pipe", "pipe"] });
```

`buildExecArgs` emits `["exec", "-i", ...envFlags, "-u", user, "-w", cwd, id,
...cmd]` — no `--` separator (docker takes the command after the container id),
unlike the old `devc exec … -- …`.

### The devcontainer runner and the logger

Both come from core; the extension writes neither.

```ts
import {
  createNodeDevcontainerRunner,
  setLogger,
  type LogLevel,
} from "@devc-tools/core";

// Once, at extension load.
setLogger((level: LogLevel, message: string) => log.push(`${level}: ${message}`));

// Per start, passed as StartOptions.devcontainer.
const devcontainer = createNodeDevcontainerRunner({
  onStderr: (chunk) => log.push(new TextDecoder().decode(chunk)),
});
```

`setLogger(null)` restores the console default; the extension never needs to,
since it owns the process for its lifetime.

### What must not change

- Every routed tool's observable behavior: same commands inside the container
  (`cat`, `tee`, `mkdir -p`, `stat -c %F`, `ls -1A`, `bash -lc`, `rg`), same
  path mapping, same truncation, same grep reformatting.
- `read_host` / `list_host_docs` and the whole mount-exclusion barrier — the
  mount table's *source* changes, its *shape* does not.
- The home-directory confirmation, its sticky caching, and its no-UI refusal.
- `!` routed / `!!` on the host.
- The `session_start` warm-up, the `/devcontainer` command's four lines, and
  the `before_agent_start` system-prompt rewrite.
- No teardown on exit. `devc stop` / `devc down` remain the user's job — the
  `devc` CLI is now *complementary*, not *required*.

## Concept boundaries

- **`src/container.ts` (this extension) vs. `container.ts` (inside
  `@devc-tools/core`).** Same filename, different modules. Every import of
  core's goes through the bare specifier `"@devc-tools/core"`; nothing in this
  repo ever imports a relative path into the core package. A relative
  `./container.ts` always means the extension's adapter.
- **`ContainerInfo`** is now core's type, re-exported. Delete the local
  interface — do not leave a structurally-identical duplicate.
- **`ContainerMount` (core) vs. `HostMount` (`pi-extension-host-read-core`)**
  are structurally identical and deliberately separate: host-read-core must
  stay backend-agnostic (sbx supplies its own). `getMounts` converts; it does
  not make host-read-core depend on core.
- **`ExecOptions`/`ExecResult` (core) vs. `RunOptions`/`RunResult` (here).**
  Do not import core's — the extension's carry streaming, stdin, abort and
  timeout that core's do not. Never import both into one module.
- **`execInContainer` (core)** is exported and must not be used. See the first
  design decision.
- **`nodeDevcontainerRunner` (core's no-options instance) vs.
  `createNodeDevcontainerRunner({ onStderr })`.** The bare instance inherits
  stderr — correct for a CLI, wrong here. Always use the factory.
- **`DevcInfraError`** keeps its name (it appears in user-facing messages) but
  now means "container/docker infra failure", not "the devc CLI failed".

## Checklist

- [x] `npm pack` in `devc-tools/devc-core/`; install the tarball into
      `extensions/devcontainer` for local work (**not** committed)
- [x] `src/devc.ts` → `src/container.ts`; `ContainerInfo` re-exported from
      core, local interface deleted
- [x] `setLogger` at extension load + `createNodeDevcontainerRunner({ onStderr })`
      per start, both feeding one buffer
- [x] `ensureContainer` — `startContainer(hostCwd, false, { devcontainer })`,
      failures rethrown as `DevcInfraError` with the buffered lines appended
- [x] `runInContainer(info, argv, opts, spawn)` — `buildExecArgs` + the
      existing spawn driver, unchanged stdin/streaming/abort/timeout handling
- [x] `getMounts` — `getContainerMounts(hostCwd) ?? []`, wrapped in a
      try/catch that rethrows as `DevcInfraError`: core **throws** when
      docker is absent (confirmed: `spawn docker ENOENT`), where `devc
      mounts` used to exit non-zero and be mapped by the caller
- [x] Delete `resolveDevcInvocation` and every `$DEVC_BIN` reference
- [x] `tools.ts` / `index.ts` — import path, `boundRun(info)`, `run`
      constructed per-`ensureContainerForTool` rather than once at load
- [x] `devc.test.ts` → `container.test.ts`: argv assertions retargeted to
      `docker exec`, `$DEVC_BIN` test removed, `ensureContainer`/`getMounts`
      tests reworked against an injected core (or a resolved-`info` fixture) —
      the suite must still need neither Docker nor a real container
- [x] Docs: `extensions/devcontainer/README.md` (Requirements, Development,
      the `devc` framing in the intro), root `README.md`,
      `host-read-core/README.md:33`, `sbx/README.md:92`. Also
      `scripts/bash_aliases_pic.sh` and stale `$DEVC_BIN` / `devc exec`
      mentions in `gondolin/src/{config,paths,tools}.ts`,
      `sbx/src/sbx.ts` and `host-read-core/src/host-read.ts` — comment-only,
      found by grep, not in the plan's touchpoints table
- [ ] **Last, gated on the publish:** `"@devc-tools/core": "0.1.0"` (exact —
      core is pre-1.0 and `buildExecArgs` is not a stability promise) and a
      regenerated root `package-lock.json`. **Half done, deliberately.**
      `package.json` carries the exact version already — that is the intended
      final state — but `@devc-tools/core` is not published, so the committed
      `package-lock.json` is the pre-change one and a from-clean
      `npm install` **will fail** until the publish. Local work used an
      `npm pack`ed tarball installed into `node_modules`; no `file:` or
      `.tgz` path is committed. Regenerate the lockfile when publishing.

## Validation

- [x] `npm run typecheck` and `npm test` in `extensions/devcontainer` (38
      passing, up from 34) plus every other workspace package —
      host-read-core 44, sbx 45, gondolin 33, caffeinate 8, all typechecking
      clean. Run per-package rather than via a root `npm install`, which
      cannot resolve the unpublished dependency (see the last checklist item)
- [x] Grep clean: no `DEVC_BIN` anywhere in the repo, and no `devc` spawn
      target or subcommand invocation under `extensions/`. Five prose mentions
      of `devc up` / `devc exec` / `devc mounts` survive on purpose, all in
      doc comments explaining what a thing *used to be* ("Was `devc mounts
      <hostCwd> --json`")
- [ ] **Real session, `devc` off `PATH`** — the point of the whole change.
      **Not run: no Docker daemon and no way to launch a live pi session in
      this environment.**
      `env PATH=…(no devc)… pi -e …/extensions/devcontainer` in a project:
      container starts, `/devcontainer` reports it, `read`/`write`/`edit`/
      `bash`/`grep`/`find`/`ls` all land inside it (confirm from the host with
      `docker exec <id> cat …`), `!` routes in, `!!` stays out
- [ ] **The TUI is not polluted.** Start against a project whose image needs a
      real build, so `devcontainer up` produces sustained stderr. pi's display
      must stay intact for the whole build — this exercises both seams at once
      (`onStderr` for the CLI's output, `setLogger` for core's own). Then force
      a build *failure* and confirm the buffered output reaches the user as a
      notification instead of vanishing. A first run against a **fresh** cache
      key is the one that actually produces build output; a warm one will not.
      **Not run — needs Docker and a live TUI.** What *is* covered by unit
      tests: that `setLogger` and the runner's `onStderr` both land in the
      buffer instead of the console, that the buffer reaches the error message
      on a failed start, and that a whole log message is not concatenated onto
      a partial stderr chunk (that last one was a real bug, found and fixed
      while finishing this plan)
- [ ] **Binary round-trip.** `read` a binary file (e.g. a PNG in the
      workspace) and confirm the bytes are intact — the regression
      `execInContainer`'s string-returning piped mode would have caused.
      **Not run end to end (needs Docker).** The unit test
      `read.readFile issues \`cat -- <containerPath>\` and returns bytes`
      pins the `Buffer` path through the adapter, which is where the
      regression would live
- [ ] Cancellation and timeout still work: a long `bash` tool call
      interrupted mid-run kills the `docker exec` child. **Not run against a
      real child (needs Docker).** Unit-tested against the injected spawn:
      an already-aborted signal rejects immediately, and the driver's
      abort/timeout paths are unchanged from the pre-change code
- [ ] `read_host` still refuses a path inside a mount source, and
      `list_host_docs` still lists pi's docs root — i.e. `getMounts` returns
      the same table core's `getContainerMounts` used to produce via the CLI.
      **Not run against a real container (needs Docker).** host-read-core's
      own 44 tests still pass unchanged, so the barrier logic is intact; what
      is unverified is only that the new `getMounts` feeds it the same rows
- [ ] Home-directory gate: launch pi from `$HOME`, confirm the prompt, confirm
      declining leaves no container (`docker ps -a`). **Not run — needs a live
      pi session.** The gate's code path is untouched by this plan

## Out of scope

- Any change to `devc-tools`. The `log` seam on `StartOptions` noted above is
  a follow-up there, not a dependency of this plan.
- `extensions/sbx` and `extensions/gondolin`. `sbx` keeps spawning its own
  binary; nothing about this change generalizes to it.
- Exposing devc's other commands (`init`, `config`, `stop`, `down`) as pi
  commands, even though core now makes them one import away.
- Publishing `@devc-tools/core` itself — that happens in the other repo.
