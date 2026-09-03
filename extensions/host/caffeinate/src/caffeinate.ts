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
 * `-i` prevents idle sleep — the main trigger that would suspend an
 * unattended agent's process — on both AC and battery. `-s` adds narrower
 * coverage for the same failure mode (system sleep) via a *scheduled* sleep
 * (Energy Saver / `pmset repeat`), but only while on AC power.
 *
 * Deliberately excludes `-d` (display) and `-m` (disk): neither affects
 * whether the agent's process keeps running — display sleep doesn't pause
 * background work, and modern SSDs barely have a meaningful disk-sleep state
 * that active agent I/O wouldn't already prevent on its own.
 *
 * Override via `$PI_CAFFEINATE_ARGS` (whitespace-split), e.g.
 * `PI_CAFFEINATE_ARGS="-d -i -m -s"` to also keep the display lit and hold
 * disk sleep.
 */
const DEFAULT_ARGS = ["-i", "-s"];

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
