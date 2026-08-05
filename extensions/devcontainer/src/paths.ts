/**
 * Host ↔ container path mapping, anchored on a single pair established at
 * session start: pi's host cwd ↔ the container's `remoteWorkspaceFolder`.
 *
 * Mirrors gondolin's `toGuestPath`, but with `remoteWorkspaceFolder` as the
 * guest root instead of a hard-coded `/workspace` (the devcontainer workspace
 * folder is whatever `devc up` reports — it differs for git worktrees).
 */

import path from "node:path";

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

/** True when `value` is `root` itself or lives under it (no `..` escape). */
function isInsideHostPath(root: string, value: string): boolean {
  const relativePath = path.relative(root, value);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

/**
 * True if `dir` is exactly `home` — not a subpath, not a parent. Both are
 * `path.resolve`d first, so trailing slashes and `.`/`..` segments don't
 * affect the comparison.
 */
export function isHomeDirectory(dir: string, home: string): boolean {
  return path.resolve(dir) === path.resolve(home);
}

/**
 * Map a path from a routed tool into its container-side path. All routed tools
 * interpret paths as *container* paths:
 *
 * - a relative path resolves against `remoteWorkspaceFolder`;
 * - an absolute path that lies under `hostCwd` is rewritten into
 *   `remoteWorkspaceFolder` (covers a host-workspace path the model may still
 *   emit);
 * - any other absolute path is treated as a container absolute path as-is.
 *
 * A leading `@` (pi's file-reference sigil) is stripped first.
 */
export function toContainerPath(
  input: string,
  hostCwd: string,
  remoteWorkspaceFolder: string,
): string {
  const trimmed = stripAtPrefix(input.trim());
  if (!trimmed) return remoteWorkspaceFolder;

  if (path.isAbsolute(trimmed)) {
    if (isInsideHostPath(hostCwd, trimmed)) {
      const relativePath = path.relative(hostCwd, trimmed);
      return relativePath
        ? path.posix.join(remoteWorkspaceFolder, toPosix(relativePath))
        : remoteWorkspaceFolder;
    }
    // Already a container-absolute path — normalise separators, keep as-is.
    return path.posix.resolve("/", toPosix(trimmed));
  }

  return path.posix.resolve(remoteWorkspaceFolder, toPosix(trimmed));
}
