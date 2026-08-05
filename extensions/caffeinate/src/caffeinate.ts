/**
 * Spawn wrapper over macOS's `caffeinate` binary — this extension's only
 * runtime dependency. The spawner is injectable so tests can assert argv
 * without a real `caffeinate` binary (and without running on macOS).
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

/** Injectable child-process spawner so tests assert argv without real `caffeinate`. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

const defaultSpawn = nodeSpawn as unknown as SpawnFn;

const BINARY = "caffeinate";

/**
 * `-i` prevents idle sleep — the common "don't let the Mac nap while
 * something unattended is working" case — without forcing the display on or
 * overriding an explicit lid-close/battery choice (unlike `-d`/`-s`).
 * Override via `$PI_CAFFEINATE_ARGS` (whitespace-split), e.g.
 * `PI_CAFFEINATE_ARGS="-d -i -s"` to also keep the display lit and hold
 * system sleep while on AC power.
 */
const DEFAULT_ARGS = ["-i"];

export function isSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "darwin";
}

export function resolveArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.PI_CAFFEINATE_ARGS?.trim();
  return override ? override.split(/\s+/) : [...DEFAULT_ARGS];
}

export interface CaffeinateHandle {
  readonly pid: number | undefined;
  /** Kill the caffeinate process. Idempotent — safe to call more than once. */
  stop(): void;
}

/**
 * Spawns `caffeinate <args>` and returns a handle to stop it. With no time
 * limit or watched pid, `caffeinate` runs until killed, so `stop()` is the
 * only way this exits — the process holds its sleep assertion for exactly
 * the lifetime the caller keeps the handle running.
 *
 * A spawn failure (e.g. `caffeinate` missing — not macOS, or a broken PATH)
 * is reported via `onError` rather than thrown, so a missing binary never
 * breaks the agent run it was meant to accompany.
 */
export function startCaffeinate(
  args: string[] = resolveArgs(),
  spawn: SpawnFn = defaultSpawn,
  onError?: (err: Error) => void,
): CaffeinateHandle {
  const child = spawn(BINARY, args, { stdio: "ignore" });
  let stopped = false;

  child.on("error", (err: Error) => {
    stopped = true;
    onError?.(err);
  });

  return {
    get pid() {
      return child.pid;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (child.pid !== undefined && !child.killed) {
        child.kill();
      }
    },
  };
}
