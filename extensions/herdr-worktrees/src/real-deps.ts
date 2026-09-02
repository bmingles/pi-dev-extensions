/**
 * The real (non-fixture) implementations of `ResolveDeps` — the only place in
 * this package that touches git, `/proc/mounts`, `/.dockerenv`, or the real
 * filesystem. `worktree-path.ts` never imports `node:fs`/`node:child_process`
 * directly so it stays testable against fixtures with no I/O at all.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import type { ResolveDeps } from "./worktree-path.ts";

export function realGitRevParseTopLevel(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

export function realReadMounts(): string {
  try {
    return readFileSync("/proc/mounts", "utf8");
  } catch {
    // No /proc/mounts (e.g. not Linux) — isMounted() will simply find no
    // match, but isContainer() is what actually gates whether this is
    // reached at all.
    return "";
  }
}

export function realIsContainer(): boolean {
  return existsSync("/.dockerenv");
}

export function realPathExists(path: string): boolean {
  return existsSync(path);
}

export const realResolveDeps: ResolveDeps = {
  gitRevParseTopLevel: realGitRevParseTopLevel,
  readMounts: realReadMounts,
  isContainer: realIsContainer,
  pathExists: realPathExists,
  homedir: homedir(),
};
