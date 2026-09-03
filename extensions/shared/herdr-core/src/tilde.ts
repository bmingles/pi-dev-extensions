/**
 * Tilde expansion for path parameters that arrive from a model rather than a shell.
 */

import { join } from "node:path";

/**
 * Expand a leading `~` against `home` — the host's home directory on the host side, the
 * container user's inside the container.
 *
 * These tools are called by a **model**, not by a shell, so nothing upstream expands a
 * tilde: `resolve(hostCwd, "~/code/x")` treats `~` as an ordinary path segment and silently
 * produces `<hostCwd>/~/code/x`. Measured on a real host run — a model asked for
 * `repo: ~/code/tools/devc-tools` and got NOT_A_REPO naming a nonsense joined path.
 *
 * A CLI would be wrong to do this (the shell owns tilde expansion, and a literal `~` file
 * is legal), which is why `devc`'s own `--cwd` deliberately does not — but no shell is in
 * the loop for a tool call.
 *
 * Shared because both sides have the bug for the same reason: `home` is the host's home on
 * the host side and the container user's inside the container, and neither caller has a
 * shell between it and the model.
 *
 * `~user/...` is left alone: resolving it needs a passwd lookup, and guessing
 * `<home's parent>/user` would be wrong on macOS as often as not.
 */
export function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}
