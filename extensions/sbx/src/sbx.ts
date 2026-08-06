/**
 * Spawn wrappers over the `sbx` binary (Docker Sandboxes CLI). This is the
 * extension's only runtime dependency: `sbxUp` warms/attaches the sandbox
 * (`sbx run --name <name> -d shell <hostCwd>`), and `runInSandbox` runs
 * commands inside it (`sbx exec`). The spawner is injectable so tests can
 * assert the exact argv without a real `sbx` binary.
 *
 * Unlike `devc` (this repo's own CLI), `sbx` is purely an external Docker
 * Desktop binary — always invoked as `sbx` from PATH, no `$DEVC_BIN`-style
 * override, and no infra-vs-command exit-code sentinel (see the plan's
 * Concept boundaries): `runInSandbox` always resolves with the routed
 * command's real exit code, never rejecting on a non-zero exit.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import path from "node:path";
import { deriveSandboxName } from "./name.ts";

/** The fixed `sbx run`/`sbx create` agent kind this extension always uses. */
const SHELL_AGENT = "shell";

export interface SandboxInfo {
  /** The --name value used for every run/exec call (from deriveSandboxName). */
  name: string;
  /** Captured from `sbx run --name <name> -d` stdout. */
  sandboxId: string;
  /** == hostCwd — sbx mounts the workspace at the same path as the host. */
  workspace: string;
}

export interface RunOptions {
  /** -w/--workdir */
  cwd?: string;
  /** Repeated -e K=V. */
  env?: Record<string, string>;
  /** Piped to `sbx exec` stdin. */
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

/** Injectable child-process spawner, node:child_process-spawn-compatible. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

const defaultSpawn = nodeSpawn as unknown as SpawnFn;

/** Raised for an sbx-level infra failure (spawn failure, or `sbx run`/`sbx up` itself failing). */
export class SbxInfraError extends Error {
  override name = "SbxInfraError";
}

interface SpawnDriverOptions {
  stdin?: Uint8Array | string;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Spawns `sbx <args>`, pipes optional stdin, streams stdout/stderr to the
 * callbacks while also collecting them, honours an AbortSignal and a
 * timeout, and resolves with the exit code and collected buffers. Rejects
 * only on a spawn error or a timeout (never on a non-zero exit — the caller
 * inspects `code`).
 */
function spawnSbx(
  args: string[],
  opts: SpawnDriverOptions,
  spawn: SpawnFn,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn("sbx", args, { stdio: ["pipe", "pipe", "pipe"] });

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
        reject(new Error(`sbx timed out after ${opts.timeoutMs}ms`));
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

/**
 * `sbx run --name <name> -d shell <hostCwd>`. Idempotent create-or-attach
 * (per `sbx run`'s documented "creating the sandbox if it does not already
 * exist" / re-attach-by---name behavior). Uses the "shell" agent kind
 * deliberately — never a coding-agent kind (see Concept boundaries). `name`
 * defaults to one derived from `hostCwd` via `deriveSandboxName`, but a
 * caller that already found a matching sandbox via `findSandboxesForWorkspace`
 * (e.g. the picker in index.ts) can pass that sandbox's real name instead, so
 * `sbx run` attaches to it by its actual name rather than the derived one.
 * Captures stdout (trimmed, last non-empty line — mirroring devc.ts's
 * robustness against a tool that prefixes progress lines) as `sandboxId`.
 * Throws `SbxInfraError` on non-zero exit or a spawn failure (e.g. `sbx`
 * missing from PATH).
 */
export async function sbxUp(
  hostCwd: string,
  spawn: SpawnFn = defaultSpawn,
  name: string = deriveSandboxName(hostCwd),
): Promise<SandboxInfo> {
  let result: RunResult;
  try {
    result = await spawnSbx(
      ["run", "--name", name, "-d", SHELL_AGENT, hostCwd],
      {},
      spawn,
    );
  } catch (err) {
    throw new SbxInfraError(
      `sbx run failed to start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (result.code !== 0) {
    throw new SbxInfraError(
      `sbx run failed (exit ${result.code}): ${decode(result.stderr).trim()}`,
    );
  }
  const text = decode(result.stdout).trim();
  // `sbx run` may print progress/status lines before the sandbox ID; the
  // final non-empty line is the ID it printed with -d.
  const lines = text.split("\n").map((l) => l.trim()).filter((l) =>
    l.length > 0
  );
  const sandboxId = lines.at(-1) ?? "";
  if (!sandboxId) {
    throw new SbxInfraError(`sbx run: could not parse sandbox id: ${text}`);
  }
  return { name, sandboxId, workspace: hostCwd };
}

/** One row of `sbx ls --json`'s `sandboxes` array. */
export interface ExistingSandbox {
  name: string;
  id: string;
  agent: string;
  status: string;
  /** Absolute host paths mounted into this sandbox (plural: sbx's schema
   * allows more than one, though this extension only ever creates sandboxes
   * with exactly one). */
  workspaces: string[];
}

/**
 * `sbx ls --json`, parsed. Shape confirmed against a real `sbx` binary
 * (unlike the rest of this module's flag shapes — see the README's "A note
 * on the `sbx` CLI facts this extension assumes"): `{ "sandboxes": [{ name,
 * id, agent, status, workspaces: string[] }, ...] }`. Throws `SbxInfraError`
 * on a spawn failure, non-zero exit, unparseable JSON, or a response missing the
 * `sandboxes` array — callers that want to degrade gracefully (e.g. fall
 * back to creating a new sandbox rather than blocking on a listing failure)
 * are expected to catch this themselves.
 */
export async function sbxLs(
  spawn: SpawnFn = defaultSpawn,
): Promise<ExistingSandbox[]> {
  let result: RunResult;
  try {
    result = await spawnSbx(["ls", "--json"], {}, spawn);
  } catch (err) {
    throw new SbxInfraError(
      `sbx ls failed to start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (result.code !== 0) {
    throw new SbxInfraError(
      `sbx ls failed (exit ${result.code}): ${decode(result.stderr).trim()}`,
    );
  }
  const text = decode(result.stdout).trim();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : { sandboxes: [] };
  } catch {
    throw new SbxInfraError(`sbx ls --json: could not parse output: ${text}`);
  }
  const sandboxes = (parsed as { sandboxes?: unknown }).sandboxes;
  if (!Array.isArray(sandboxes)) {
    throw new SbxInfraError(
      `sbx ls --json: unexpected shape (no "sandboxes" array): ${text}`,
    );
  }
  return sandboxes.map((raw) => {
    const rec = raw as Record<string, unknown>;
    return {
      name: String(rec.name ?? ""),
      id: String(rec.id ?? ""),
      agent: String(rec.agent ?? ""),
      status: String(rec.status ?? ""),
      workspaces: Array.isArray(rec.workspaces)
        ? rec.workspaces.map(String)
        : [],
    };
  });
}

/**
 * Existing sandboxes (per `sbx ls --json`) that already mount `hostCwd` —
 * the set `index.ts`'s picker offers instead of blindly creating another
 * sandbox via `deriveSandboxName`. Restricted to the "shell" agent kind
 * (same restriction `sbxUp` applies when creating): a coding-agent-kind
 * sandbox mounting the same path is a different concept entirely, not a
 * candidate to route this extension's tools into. Paths are compared via
 * `path.resolve` on both sides, so a relative or trailing-slash `hostCwd`
 * still matches an absolute entry in `workspaces`.
 */
export async function findSandboxesForWorkspace(
  hostCwd: string,
  spawn: SpawnFn = defaultSpawn,
): Promise<ExistingSandbox[]> {
  const resolved = path.resolve(hostCwd);
  const all = await sbxLs(spawn);
  return all.filter(
    (s) =>
      s.agent === SHELL_AGENT &&
      s.workspaces.some((w) => path.resolve(w) === resolved),
  );
}

/**
 * `sbx exec -i [-w <cwd>] [-e K=V]... <name> <argv…>`. Streams
 * stdout/stderr to the callbacks (and/or collects them), pipes `stdin`,
 * honors `signal`/`timeoutMs`, and resolves with the routed command's own
 * exit code. Rejects (throws) only on a spawn-level failure, never on the
 * routed command's own non-zero exit — there is no infra-vs-command
 * exit-code sentinel for `sbx exec` (see Concept boundaries).
 */
export async function runInSandbox(
  name: string,
  argv: string[],
  opts: RunOptions = {},
  spawn: SpawnFn = defaultSpawn,
): Promise<RunResult> {
  const args = ["exec", "-i"];
  if (opts.cwd) args.push("-w", opts.cwd);
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      args.push("-e", `${k}=${v}`);
    }
  }
  args.push(name, ...argv);

  return spawnSbx(
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
}
