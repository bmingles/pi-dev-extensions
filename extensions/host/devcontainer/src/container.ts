/**
 * The container adapter: resolves the devcontainer for pi's launch directory and
 * runs commands inside it.
 *
 * This used to shell out to a `devc` binary and parse its stdout. It now calls
 * devc's own lifecycle logic in-process, as the `@devc-tools/core` npm library —
 * so the extension's runtime prerequisites are Docker and Node, with no `devc`
 * on PATH and no version skew between a binary installed months ago and the
 * extension driving it.
 *
 * Core supplies the *lifecycle* (`startContainer`, `getContainerMounts`) and the
 * *argv* (`buildExecArgs`); the spawn driver below stays the extension's own.
 * Core's `execInContainer` looks like the obvious replacement for `devc exec`
 * and is the wrong tool twice over: it re-runs `startContainer` on every call
 * (the container is resolved once per session here), and its piped mode returns
 * decoded strings with no stdin, no incremental output, no `AbortSignal` and no
 * timeout — all four of which the routed tools need (`read` returns raw bytes,
 * `write` pipes content to `tee`, `bash` streams and cancels).
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  buildExecArgs,
  createNodeDevcontainerRunner,
  type DevcontainerRunner,
  getContainerMounts,
  type LogLevel,
  setLogger,
  startContainer,
} from "@devc-tools/core";
import type { ContainerInfo } from "@devc-tools/core";
import type { HostMount } from "pi-extension-host-read-core";

/**
 * Core's own type, re-exported so `tools.ts` and `index.ts` import one name from
 * one place. There is deliberately no local copy: a structurally-identical
 * duplicate would drift the first time core's shape changes.
 */
export type { ContainerInfo } from "@devc-tools/core";

/** Injectable child-process spawner so tests assert argv without a real docker. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface RunOptions {
  /** Container-side cwd (`docker exec -w`). Defaults to remoteWorkspaceFolder. */
  cwd?: string;
  /** Extra `-e K=V` entries applied on top of the container's remoteEnv. */
  env?: Record<string, string>;
  /** Piped to the `docker exec` child's stdin. */
  stdin?: Uint8Array | string;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/**
 * `docker exec` uses exit code 125 for its own failures (as opposed to the
 * exec'd command's exit code) by convention. With core, a container that won't
 * start throws out of `ensureContainer` and never reaches this path at all, so
 * the mapping is now a backstop rather than the primary infra signal — but it
 * is still the difference between "docker is broken" and "the command failed".
 */
const INFRA_EXIT_CODE = 125;

const defaultSpawn = nodeSpawn as unknown as SpawnFn;

/** Raised for a container/docker infra failure (rather than a routed command failing). */
export class DevcInfraError extends Error {
  override name = "DevcInfraError";
}

/**
 * Everything core has to say about a start, in arrival order: its own notices
 * (via `setLogger`) interleaved with the devcontainer CLI's stderr (via the
 * runner's `onStderr`). Nothing here reaches the terminal — pi owns it, and a
 * stray `console.log` or an inherited stderr corrupts the TUI mid-render. The
 * buffer is appended to the error when a start fails (that is the only place a
 * cold build's output is worth anything) and dropped when it succeeds.
 *
 * Capped, because a cold `devcontainer up` is minutes of build output and none
 * of the early lines survive into a useful error message anyway.
 */
const MAX_BUFFERED_LINES = 200;
const buffered: string[] = [];

function bufferLine(line: string): void {
  buffered.push(line);
  if (buffered.length > MAX_BUFFERED_LINES) {
    buffered.splice(0, buffered.length - MAX_BUFFERED_LINES);
  }
}

// Once, at module load — core's log sink is process-global by design, and this
// module is the only thing in the extension that drives core.
// The trailing newline matters: the buffer is joined with `""` because stderr
// arrives as partial chunks, so a whole logger message with no terminator would
// be glued onto whatever chunk follows it.
setLogger((level: LogLevel, message: string) =>
  bufferLine(`${level}: ${message}\n`)
);

/** Test seam for `ensureContainer`; production passes nothing and gets core. */
export interface EnsureContainerDeps {
  /** Defaults to core's `startContainer`. */
  start?: typeof startContainer;
  /** Defaults to core's `createNodeDevcontainerRunner`. */
  createRunner?: (
    opts: { onStderr?: (chunk: Uint8Array) => void },
  ) => DevcontainerRunner;
}

/**
 * Was `devcUp`. Starts (or warms, when it is already running) the container
 * rooted at `hostCwd` and resolves with the anchor every routed tool is built
 * from.
 *
 * Always `createNodeDevcontainerRunner({ onStderr })`, never core's bare
 * `nodeDevcontainerRunner`: the no-options instance *inherits* the devcontainer
 * CLI's stderr, which is right for a CLI and writes straight into pi's display
 * here.
 */
export async function ensureContainer(
  hostCwd: string,
  deps: EnsureContainerDeps = {},
): Promise<ContainerInfo> {
  const start = deps.start ?? startContainer;
  const createRunner = deps.createRunner ?? createNodeDevcontainerRunner;

  buffered.length = 0;
  // One decoder for the whole run, in streaming mode: the CLI's stderr arrives
  // in arbitrary chunks that can split a multi-byte sequence.
  const decoder = new TextDecoder();
  const devcontainer = createRunner({
    onStderr: (chunk) => bufferLine(decoder.decode(chunk, { stream: true })),
  });

  try {
    return await start(hostCwd, false, { devcontainer });
  } catch (err) {
    // The buffered lines are the whole story of a failed build; core's thrown
    // message on its own is usually just "devcontainer up failed with exit
    // code 1".
    const detail = buffered.join("").trim();
    throw new DevcInfraError(
      `devcontainer start failed: ${describeError(err)}${
        detail ? `\n${detail}` : ""
      }`,
    );
  } finally {
    buffered.length = 0;
  }
}

/**
 * Was `devc mounts <hostCwd> --json`. Core returns `null` (not an empty array)
 * when no container matches the cwd, which is the same "nothing is mounted"
 * answer the CLI expressed as `[]`.
 *
 * The try/catch is not decoration: `getContainerMounts` **throws** when docker
 * is absent (`spawn docker ENOENT`), where the CLI used to exit non-zero and be
 * mapped here. `read_host`'s mount barrier must never see that as "no mounts",
 * which would silently drop the exclusion it exists to enforce.
 */
export async function getMounts(
  hostCwd: string,
  fetchMounts: typeof getContainerMounts = getContainerMounts,
): Promise<HostMount[]> {
  let mounts: Awaited<ReturnType<typeof getContainerMounts>>;
  try {
    mounts = await fetchMounts(hostCwd);
  } catch (err) {
    throw new DevcInfraError(
      `container mounts unavailable: ${describeError(err)}`,
    );
  }
  // Converted, not passed through: `HostMount` belongs to the backend-agnostic
  // host-read-core package and must not become an alias of core's type.
  return (mounts ?? []).map((m) => ({
    type: m.type,
    source: m.source,
    destination: m.destination,
    rw: m.rw,
  }));
}

/**
 * Cheap "is this identity still good" check — one `docker inspect`, not a full
 * `devcontainer up`. Backs `index.ts`'s cached-`ContainerInfo` invalidation: a rebuild
 * *underneath a running pi* (`docker rm` of the old container, a fresh `docker run` sharing
 * the same `devcontainer.local_folder` label) leaves the cached `containerId` pointing at
 * nothing, while `getMounts` above re-resolves fresh on every call and would silently
 * disagree with it. `false` covers both "removed" (`docker inspect` errors — no such
 * container) and "exists but stopped" (`docker exec` needs a running container either way),
 * so either case sends the caller back through `startContainer` to re-resolve.
 */
export async function isContainerRunning(
  containerId: string,
  spawn: SpawnFn = defaultSpawn,
): Promise<boolean> {
  const result = await spawnDocker(
    ["inspect", "--format", "{{.State.Running}}", containerId],
    {},
    spawn,
  );
  return result.code === 0 && decode(result.stdout).trim() === "true";
}

interface SpawnDriverOptions {
  stdin?: Uint8Array | string;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Spawns `docker <args>`, pipes optional stdin, streams stdout/stderr to the
 * callbacks while also collecting them, honours an AbortSignal and a timeout,
 * and resolves with the exit code and collected buffers. Rejects only on a
 * spawn error or a timeout (never on a non-zero exit — the caller inspects
 * `code`).
 *
 * Bytes in, bytes out: nothing here decodes, so `read`'s `cat` of a PNG comes
 * back intact.
 */
function spawnDocker(
  args: string[],
  opts: SpawnDriverOptions,
  spawn: SpawnFn,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => child.kill("SIGTERM");

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    if (opts.signal) {
      if (opts.signal.aborted) child.kill("SIGTERM");
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, opts.timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      outChunks.push(chunk);
      opts.onStdout?.(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errChunks.push(chunk);
      opts.onStderr?.(chunk);
    });

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        reject(new Error(`docker exec timed out after ${opts.timeoutMs}ms`));
        return;
      }
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks),
      });
    });

    if (child.stdin) {
      if (opts.stdin !== undefined) {
        child.stdin.write(
          typeof opts.stdin === "string"
            ? Buffer.from(opts.stdin, "utf8")
            : opts.stdin,
        );
      }
      child.stdin.end();
    }
  });
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `docker exec -i [-e K=V]… -u <user> -w <cwd> <id> <argv…>`, with the argv
 * built by core's `buildExecArgs` so the extension and `devc exec` agree on it
 * by construction. Streams stdout/stderr to the callbacks (and/or collects
 * them), pipes `stdin`, and resolves with the child's exit code and collected
 * buffers.
 *
 * Takes the resolved `ContainerInfo` rather than a host path — the argv needs
 * the container id, the remote user and the remote env, all of which the caller
 * already holds from `ensureContainer`. Note the absence of a `--` separator:
 * docker takes the command straight after the container id, unlike the old
 * `devc exec … -- …`.
 */
export async function runInContainer(
  info: ContainerInfo,
  argv: string[],
  opts: RunOptions = {},
  spawn: SpawnFn = defaultSpawn,
): Promise<RunResult> {
  const args = buildExecArgs({
    containerId: info.containerId,
    remoteUser: info.remoteUser,
    cwd: opts.cwd ?? info.remoteWorkspaceFolder,
    remoteEnv: info.remoteEnv,
    env: opts.env ?? {},
    cmd: argv,
  });

  const result = await spawnDocker(
    args,
    {
      stdin: opts.stdin,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    },
    spawn,
  );

  if (result.code === INFRA_EXIT_CODE) {
    throw new DevcInfraError(
      `docker exec infra failure (exit ${INFRA_EXIT_CODE}): ${
        decode(result.stderr).trim()
      }`,
    );
  }
  return result;
}
