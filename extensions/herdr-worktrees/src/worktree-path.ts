/**
 * Pure path derivation + mount guard for the devcontainer `.worktrees`
 * sibling convention.
 *
 * This module owns exactly one job: given a repo root and a branch name,
 * decide *where* a worktree checkout should live under this host's layout
 * (`<parent>/<repo>.worktrees/<slug>`, never Herdr's own
 * `<worktrees.directory>/<repo>/<slug>`), and refuse to answer with a path
 * that Herdr would silently create outside a bind mount.
 *
 * Every dependency that touches the outside world (git, `/proc/mounts`,
 * `/.dockerenv`, the filesystem) is injected so this can be exercised with
 * fixtures — no server, no pi, no real container. See `worktree-path.test.ts`.
 *
 * All paths in and out are **container paths**. This module does not
 * translate host <-> container paths and must not try to: in the topology
 * this extension serves, nothing needs a host path, and a container cannot
 * derive one anyway (`/proc/mounts` reports a bind source like
 * `/run/host_mark/Users`, not the host path that was actually mounted).
 */

import { dirname, join, normalize, resolve } from "node:path";

/** Everything this module needs from the outside world, injectable for tests. */
export interface ResolveDeps {
  /** `git rev-parse --show-toplevel` from `cwd`, or `undefined` if not a repo. */
  gitRevParseTopLevel(cwd: string): string | undefined;
  /** Raw contents of `/proc/mounts` (or an equivalent fixture). */
  readMounts(): string;
  /** Whether we are running inside a container (gates the mount check). */
  isContainer(): boolean;
  /** Whether a path already exists on disk. */
  pathExists(path: string): boolean;
}

export type WorktreePathErrorCode = "NOT_A_REPO" | "NOT_A_MOUNT" | "PATH_EXISTS";

export interface WorktreePathOk {
  ok: true;
  repoRoot: string;
  repoName: string;
  worktreesDir: string;
  path: string;
  branch: string;
  slug: string;
  /** Always true on success: either verified as a bind mount, or the check
   * was skipped because we are not in a container, where every path is
   * effectively "mounted". */
  mounted: true;
}

export interface WorktreePathErr {
  ok: false;
  code: WorktreePathErrorCode;
  message: string;
}

export type WorktreePathResult = WorktreePathOk | WorktreePathErr;

/**
 * `slug(branch)`: lowercase, `/` and anything outside `[a-z0-9._-]` replaced
 * with `-`, runs of `-` collapsed, leading/trailing `-` trimmed.
 * `feature/foo_bar` -> `feature-foo_bar`.
 *
 * Deliberately does not try to match Herdr's own branch-slug rule (used only
 * under `worktrees.directory`, the layout this extension never takes).
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

/**
 * Unescape the octal escapes (`\040` = space, `\011` = tab, `\012` = newline,
 * `\134` = backslash) that `/proc/mounts` uses for special characters in a
 * field, mirroring what `getmntent(3)` produces.
 */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct) =>
    String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Is `target` itself a mountpoint according to `mountsText` (the contents of
 * `/proc/mounts`)? Exact match on the mountpoint column — this is not an
 * ancestor check, because the whole point is that `worktreesDir` itself must
 * be the bind mount, not merely reachable through one.
 *
 * Deliberately not `existsSync`: an unmounted directory can exist (Herdr
 * `mkdir -p`s it), which is precisely the hazard this check exists to catch.
 */
export function isMounted(target: string, mountsText: string): boolean {
  const normalizedTarget = normalize(target);
  for (const line of mountsText.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 2) continue;
    const mountpoint = unescapeMountField(fields[1]);
    if (normalize(mountpoint) === normalizedTarget) return true;
  }
  return false;
}

/**
 * Resolve where a worktree for `branch` should live, guarding against the
 * one hazard that matters: `worktreesDir` not being a bind mount.
 *
 * Order of checks: repo resolution, then the mount guard (skipped outside a
 * container), then whether the target path already exists.
 */
export function resolveWorktreePath(
  params: { repo?: string; branch: string },
  cwd: string,
  deps: ResolveDeps,
): WorktreePathResult {
  const startPath = params.repo ? resolve(cwd, params.repo) : cwd;
  const repoRoot = deps.gitRevParseTopLevel(startPath);
  if (!repoRoot) {
    return {
      ok: false,
      code: "NOT_A_REPO",
      message:
        `No git repository found at or above '${startPath}'. ` +
        "Pass `repo` as a path inside the repo you want a worktree for, " +
        "or run from within it.",
    };
  }

  const { repoName, worktreesDir, path, slug } = deriveWorktreeLayout(
    repoRoot,
    params.branch,
  );

  if (deps.isContainer() && !isMounted(worktreesDir, deps.readMounts())) {
    return {
      ok: false,
      code: "NOT_A_MOUNT",
      message:
        `'${worktreesDir}' is not bind-mounted into this container. ` +
        "Herdr would `mkdir -p` it and report success, but the checkout " +
        "would live only in the container's writable layer — invisible to " +
        "the host, gone on rebuild, and leaving a dangling worktree entry " +
        `in '${repoRoot}/.git/worktrees'. Fix: add a sibling ` +
        `'${repoName}.worktrees' bind mount for this repo in ` +
        "`.devc/devc.jsonc` (via `devc config`), then retry.",
    };
  }

  if (deps.pathExists(path)) {
    return {
      ok: false,
      code: "PATH_EXISTS",
      message: `'${path}' already exists.`,
    };
  }

  return {
    ok: true,
    repoRoot,
    repoName,
    worktreesDir,
    path,
    branch: params.branch,
    slug,
    mounted: true,
  };
}
