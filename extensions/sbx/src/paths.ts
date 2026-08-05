/**
 * Ported verbatim from `pi-extensions/devcontainer/src/paths.ts` — see that
 * file for the reasoning. Unlike devcontainer, there is no
 * `toContainerPath`/path-remapping layer here: `sbx` mounts the workspace at
 * the same path as on the host, so a path a routed tool receives is already
 * the correct sandbox path. Nothing else belongs in this file.
 */

import path from "node:path";

/**
 * True if `dir` is exactly `home` — not a subpath, not a parent. Both are
 * `path.resolve`d first, so trailing slashes and `.`/`..` segments don't
 * affect the comparison.
 */
export function isHomeDirectory(dir: string, home: string): boolean {
  return path.resolve(dir) === path.resolve(home);
}
