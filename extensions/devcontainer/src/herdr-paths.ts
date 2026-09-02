/**
 * Where a worktree for a branch goes on the **host**, and whether the container can see it.
 *
 * The derivation is the shared `<parent>/<repo>.worktrees/<slug>` rule
 * (`pi-extension-herdr-core`'s `deriveWorktreeLayout`) — identical on both sides of the
 * container boundary. Only the guard differs, and it inverts relative to the container-side
 * one in `herdr-worktrees`:
 *
 *   | | in-container (`herdr-worktrees`) | host-side (here) |
 *   | question | is `<repo>.worktrees` itself a mountpoint? | is the derived host path *inside* a bind mount of the target container? |
 *   | evidence | `/proc/mounts` | `docker inspect`, via core's `getContainerMounts` |
 *   | code | `NOT_A_MOUNT` | `NOT_MOUNTED_IN_CONTAINER` |
 *   | byproduct | none | **the container path the agent needs as its cwd** |
 *
 * The two codes are deliberately different strings: they are different predicates, and a
 * reader grepping for one must not find the other.
 *
 * Pure given the mount table and the two injected probes — no `docker`, no `herdr`, no pi.
 */

import { resolve } from "node:path";
import { deriveWorktreeLayout } from "pi-extension-herdr-core";
import type { ContainerMount } from "@devc-tools/core";
import { findMountForHostPath, hostToContainerPath } from "@devc-tools/core";

export type HerdrPathErrorCode =
  | "NOT_A_REPO"
  | "NOT_MOUNTED_IN_CONTAINER"
  | "PATH_EXISTS";

export interface HerdrWorktreePathOk {
  ok: true;
  /** Host path of the primary checkout. */
  repoRoot: string;
  repoName: string;
  /** Host path of the `<repo>.worktrees` sibling directory. */
  worktreesDir: string;
  hostPath: string;
  containerPath: string;
  branch: string;
  slug: string;
  /** The bind mount the translation resolved through. */
  mount: { source: string; destination: string };
}

export interface HerdrWorktreePathErr {
  ok: false;
  code: HerdrPathErrorCode;
  message: string;
}

export type HerdrWorktreePathResult =
  | HerdrWorktreePathOk
  | HerdrWorktreePathErr;

/** The two outside-world probes this module needs, injected so tests need no repo on disk. */
export interface HerdrPathDeps {
  /** `git rev-parse --show-toplevel` from `cwd`, on the HOST. Undefined when not a repo. */
  gitRevParseTopLevel(cwd: string): string | undefined;
  /** Whether a HOST path already exists. */
  pathExists(path: string): boolean;
}

/**
 * Resolve the host path a worktree for `branch` would take, and the container path that
 * corresponds to it. Creates nothing and never calls `herdr`.
 *
 * `repo` is a **host** path inside the repo (default: pi's host cwd) — this extension runs
 * on the host, and so does the git that answers for it.
 */
export function resolveHerdrWorktreePath(
  params: { repo?: string; branch: string },
  hostCwd: string,
  mounts: ContainerMount[],
  deps: HerdrPathDeps,
): HerdrWorktreePathResult {
  const startPath = params.repo ? resolve(hostCwd, params.repo) : hostCwd;
  const repoRoot = deps.gitRevParseTopLevel(startPath);
  if (!repoRoot) {
    return {
      ok: false,
      code: "NOT_A_REPO",
      message: `No git repository found at or above '${startPath}' on this host. ` +
        "Pass `repo` as a host path inside the repo you want a worktree for, " +
        "or start pi from within it.",
    };
  }

  const { repoName, worktreesDir, path: hostPath, slug } = deriveWorktreeLayout(
    repoRoot,
    params.branch,
  );

  const match = findMountForHostPath(hostPath, mounts);
  const containerPath = match === null
    ? null
    : hostToContainerPath(hostPath, mounts);
  if (match === null || containerPath === null) {
    return {
      ok: false,
      code: "NOT_MOUNTED_IN_CONTAINER",
      message: `'${worktreesDir}' is not covered by any bind mount of this ` +
        "container, so a checkout created there would be invisible to the " +
        "agent — the container simply has no path for it. Fix: add a sibling " +
        `'${repoName}.worktrees' bind mount for this repo in ` +
        "`.devc/devc.jsonc` (via `devc config`), rebuild the container, then " +
        "retry. This is not a retryable failure.",
    };
  }

  if (deps.pathExists(hostPath)) {
    return {
      ok: false,
      code: "PATH_EXISTS",
      message: `'${hostPath}' already exists on the host.`,
    };
  }

  return {
    ok: true,
    repoRoot,
    repoName,
    worktreesDir,
    hostPath,
    containerPath,
    branch: params.branch,
    slug,
    mount: {
      source: match.mount.source,
      destination: match.mount.destination,
    },
  };
}
