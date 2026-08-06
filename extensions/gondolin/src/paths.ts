/**
 * Host ↔ guest path mapping for the gondolin micro-VM, anchored on the fixed
 * guest workspace root (`GUEST_WORKSPACE`, see `./vm.ts`) the host cwd is
 * mounted at.
 *
 * Ported from `pi-extensions/devcontainer/src/paths.ts` — same shape, with
 * `remoteWorkspaceFolder` replaced by the constant guest workspace root:
 * gondolin's mount point never varies session to session (unlike a
 * devcontainer's `remoteWorkspaceFolder`, which `devc up` resolves fresh each
 * time), so callers pass it in rather than reading it off a resolved info
 * object.
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
 * Map a path from a routed tool into its guest-side path. All routed tools
 * interpret paths as *guest* paths:
 *
 * - a relative path resolves against `guestWorkspace`;
 * - an absolute path that lies under `hostCwd` is rewritten into
 *   `guestWorkspace` (covers a host-workspace path the model may still emit);
 * - any other absolute path is treated as a guest-absolute path as-is.
 *
 * A leading `@` (pi's file-reference sigil) is stripped first.
 */
export function toGuestPath(
  input: string,
  hostCwd: string,
  guestWorkspace: string,
): string {
  const trimmed = stripAtPrefix(input.trim());
  if (!trimmed) return guestWorkspace;

  if (path.isAbsolute(trimmed)) {
    if (isInsideHostPath(hostCwd, trimmed)) {
      const relativePath = path.relative(hostCwd, trimmed);
      return relativePath
        ? path.posix.join(guestWorkspace, toPosix(relativePath))
        : guestWorkspace;
    }
    // Already a guest-absolute path — normalise separators, keep as-is.
    return path.posix.resolve("/", toPosix(trimmed));
  }

  return path.posix.resolve(guestWorkspace, toPosix(trimmed));
}
