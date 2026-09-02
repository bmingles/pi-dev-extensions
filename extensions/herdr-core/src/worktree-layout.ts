/**
 * The `<parent>/<repo>.worktrees/<slug>` path rule, and the branch slug it uses.
 *
 * Extracted from `herdr-worktrees`' `worktree-path.ts` because it is the one part of that
 * module that is **side-agnostic**: the derivation itself is identical whether it runs
 * inside the container (`herdr-worktrees`, guarding against an unmounted `.worktrees`) or on
 * the host (`devcontainer`'s `devcontainer_herdr_*` tools, guarding against a path no bind
 * mount covers). Only the guard differs, so only the guard stays behind.
 *
 * `WorktreeLayout.path` is deliberately a bare `path` — the one place in this codebase where
 * that is correct. Inside this package it names neither side; the *caller* labels it
 * `hostPath` (host-side) or leaves it a container path (container-side). Everything that
 * crosses the boundary names its side.
 */

import { dirname, join, normalize } from "node:path";

/**
 * `slug(branch)`: lowercase, `/` and anything outside `[a-z0-9._-]` replaced
 * with `-`, runs of `-` collapsed, leading/trailing `-` trimmed.
 * `feature/foo_bar` -> `feature-foo_bar`.
 *
 * Deliberately does not try to match Herdr's own branch-slug rule (used only
 * under `worktrees.directory`, the layout this convention never takes).
 */
export function slugify(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface WorktreeLayout {
  repoName: string;
  worktreesDir: string;
  path: string;
  slug: string;
}

/**
 * The path rule, stated once:
 *
 *   repoRoot     = git rev-parse --show-toplevel   (from `repo`, or cwd)
 *   repoName     = basename(repoRoot)
 *   worktreesDir = dirname(repoRoot) + "/" + repoName + ".worktrees"
 *   path         = worktreesDir + "/" + slug(branch)
 *
 * Both `worktreesDir` and `path` are returned normalized (no `..` segments) —
 * Herdr's `worktree create` response echoes an unnormalized `--path` back
 * verbatim while `worktree list` returns it normalized, so this module never
 * hands out anything but the normalized form.
 */
export function deriveWorktreeLayout(
  repoRoot: string,
  branch: string,
): WorktreeLayout {
  const repoName = repoRoot.split("/").filter(Boolean).pop() ?? repoRoot;
  const worktreesDir = normalize(join(dirname(repoRoot), `${repoName}.worktrees`));
  const slug = slugify(branch);
  const path = normalize(join(worktreesDir, slug));
  return { repoName, worktreesDir, path, slug };
}
