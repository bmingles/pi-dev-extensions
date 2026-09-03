/**
 * Resolve the `herdr` binary. Order: `HERDR_BIN_PATH` -> `HERDR_BIN` -> a
 * `PATH` walk -> the bare name `herdr` (left for `spawn` to ENOENT on).
 *
 * `HERDR_BIN_PATH` is set in every Herdr pane (the orchestrator's own pane
 * included) and is the most reliable of the four — unlike `PATH`, it can't
 * be shadowed by an unrelated `herdr` earlier on it, and unlike `HERDR_BIN`
 * it needs no manual setup. Checked first for that reason.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const IS_WIN = process.platform === "win32";

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const exts = IS_WIN
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, ext ? name + ext : name);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // Unreadable directory on PATH — skip it.
      }
    }
  }
  return undefined;
}

export function resolveHerdrBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_BIN_PATH || env.HERDR_BIN || findOnPath("herdr", env) ||
    "herdr";
}
