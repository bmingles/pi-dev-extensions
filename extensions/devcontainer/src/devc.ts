/**
 * Spawn wrappers over the `devc` CLI (Phase 26). This is the extension's only
 * runtime dependency: `devc up` warms/starts the devcontainer, and `devc exec`
 * runs commands inside it. The spawner is injectable so tests can assert the
 * exact argv without a real `devc` binary.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { HostMount } from "pi-extension-host-read-core";

/** Mirrors `devc up --json` output. Not shared code with devc (different runtime). */
export interface ContainerInfo {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
  remoteEnv: Record<string, string>;
}

/** Injectable child-process spawner so tests assert argv without a real devc. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface RunOptions {
  /** Container-side cwd (`--cwd`). */
  cwd?: string;
  /** Extra `--env K=V` entries applied on top of the container's remoteEnv. */
  env?: Record<string, string>;
  /** Piped to `devc exec` stdin. */
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
 * Resolves how to invoke devc from `$DEVC_BIN`, so a non-compiled devc can be
 * used without a binary on PATH — e.g.
 * `DEVC_BIN="deno run --allow-run=... /repo/devc/main.ts"`. The value is
 * whitespace-split: the first token is the executable and any remaining tokens
 * are prepended before the devc subcommand args. When unset it defaults to the
 * `devc` binary resolved from PATH.
 *
 * Whitespace-split, so paths containing spaces are unsupported via this env var;
 * compile a real `devc` binary (`deno task compile`) for that case.
 */
function resolveDevcInvocation(): { command: string; prefixArgs: string[] } {
  const raw = process.env.DEVC_BIN?.trim();
  if (!raw) return { command: "devc", prefixArgs: [] };
  const [command, ...prefixArgs] = raw.split(/\s+/);
  return { command, prefixArgs };
}

/**
 * `devc exec` reserves exit code 125 for a devc/docker infra failure (see
 * `devc/main.ts`), as opposed to a routed command's own non-zero exit.
 */
const INFRA_EXIT_CODE = 125;

const defaultSpawn = nodeSpawn as unknown as SpawnFn;

/** Raised for a devc/docker infra failure (rather than a routed command failing). */
export class DevcInfraError extends Error {
  override name = "DevcInfraError";
}

interface SpawnDriverOptions {
  stdin?: Uint8Array | string;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Spawns `devc <args>`, pipes optional stdin, streams stdout/stderr to the
 * callbacks while also collecting them, honours an AbortSignal and a timeout,
 * and resolves with the exit code and collected buffers. Rejects only on a
 * spawn error or a timeout (never on a non-zero exit — the caller inspects
 * `code`).
 */
function spawnDevc(
  args: string[],
  opts: SpawnDriverOptions,
  spawn: SpawnFn,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const { command, prefixArgs } = resolveDevcInvocation();
    const child = spawn(command, [...prefixArgs, ...args], {
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
        reject(new Error(`devc timed out after ${opts.timeoutMs}ms`));
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

/** `devc up <hostCwd> --json` → parsed ContainerInfo. Warms/starts the container. */
export async function devcUp(
  hostCwd: string,
  spawn: SpawnFn = defaultSpawn,
): Promise<ContainerInfo> {
  const result = await spawnDevc(["up", hostCwd, "--json"], {}, spawn);
  if (result.code !== 0) {
    throw new DevcInfraError(
      `devc up failed (exit ${result.code}): ${decode(result.stderr).trim()}`,
    );
  }
  const text = decode(result.stdout).trim();
  // devc may prefix progress lines; the final non-empty line is the JSON.
  const jsonLine = text.split("\n").filter((l) => l.trim().length > 0).at(-1) ??
    "";
  try {
    return JSON.parse(jsonLine) as ContainerInfo;
  } catch {
    throw new DevcInfraError(`devc up: could not parse --json output: ${text}`);
  }
}

/**
 * `devc mounts <hostCwd> --json` → parsed mounts. devc prints `[]` (exit 0) when
 * there is no container for the cwd, so an empty array is the natural "no
 * container" result; a non-zero exit is a real infra failure.
 */
export async function getMounts(
  hostCwd: string,
  spawn: SpawnFn = defaultSpawn,
): Promise<HostMount[]> {
  const result = await spawnDevc(["mounts", hostCwd, "--json"], {}, spawn);
  if (result.code !== 0) {
    throw new DevcInfraError(
      `devc mounts failed (exit ${result.code}): ${
        decode(result.stderr).trim()
      }`,
    );
  }
  const text = decode(result.stdout).trim();
  // devc may prefix progress lines; the final non-empty line is the JSON.
  const jsonLine = text.split("\n").filter((l) => l.trim().length > 0).at(-1) ??
    "[]";
  try {
    return JSON.parse(jsonLine) as HostMount[];
  } catch {
    throw new DevcInfraError(
      `devc mounts: could not parse --json output: ${text}`,
    );
  }
}

/**
 * `devc exec <hostCwd> [--cwd] [--env]... -- <argv…>`. Streams stdout/stderr to
 * the callbacks (and/or collects them), pipes `stdin`, and resolves with the
 * child's exit code and collected buffers. Exit code 125 is surfaced as a
 * `DevcInfraError` rather than a normal command failure.
 */
export async function runInContainer(
  hostCwd: string,
  argv: string[],
  opts: RunOptions = {},
  spawn: SpawnFn = defaultSpawn,
): Promise<RunResult> {
  const args = ["exec", hostCwd];
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      args.push("--env", `${k}=${v}`);
    }
  }
  args.push("--", ...argv);

  const result = await spawnDevc(
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
      `devc exec infra failure (exit ${INFRA_EXIT_CODE}): ${
        decode(result.stderr).trim()
      }`,
    );
  }
  return result;
}
