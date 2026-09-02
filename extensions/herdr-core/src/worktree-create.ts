/**
 * Pure argv builder + tolerant response normalizer for `herdr worktree
 * create`, following the split `pi-herdr`'s `src/tools/worktrees.ts`
 * establishes (`createWorktreeArgs` / `extractWorktree`) — reimplemented
 * here rather than imported, per the "not depend on `pi-herdr`" rule in the
 * package README.
 */

export interface CreateWorktreeArgsOpts {
  /** The primary repo checkout `herdr` operates from (`--cwd`). */
  repoRoot: string;
  branch: string;
  /** Pre-derived, normalized checkout path (`--path`). */
  path: string;
  base?: string;
  label?: string;
  /** Default false: background work must not steal the human's focus. */
  focus?: boolean;
}

/**
 * `worktree create --cwd <repoRoot> --branch <branch> --path <path>
 * [--base <base>] [--label <label>] [--focus|--no-focus] --json`
 *
 * `--path` is always passed explicitly — Herdr's `worktrees.directory`
 * global root cannot express this host's `<repo>.worktrees/<branch>`
 * sibling layout, so relying on the default would produce the wrong path
 * outright, not merely a suboptimal one.
 */
export function createWorktreeArgs(opts: CreateWorktreeArgsOpts): string[] {
  const args = [
    "worktree",
    "create",
    "--cwd",
    opts.repoRoot,
    "--branch",
    opts.branch,
    "--path",
    opts.path,
  ];
  if (opts.base) args.push("--base", opts.base);
  if (opts.label) args.push("--label", opts.label);
  args.push(opts.focus ? "--focus" : "--no-focus");
  args.push("--json");
  return args;
}

export interface NormalizedWorktree {
  path?: string;
  branch?: string;
  label?: string;
  openWorkspaceId?: string;
}

function pickStr(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function normalizeWorktree(w: unknown): NormalizedWorktree {
  if (!w || typeof w !== "object") return {};
  const o = w as Record<string, unknown>;
  return {
    path: pickStr(o, "path"),
    branch: pickStr(o, "branch"),
    label: pickStr(o, "label"),
    openWorkspaceId: pickStr(
      o,
      "open_workspace_id",
      "openWorkspaceId",
      "workspace_id",
      "workspaceId",
    ),
  };
}

/**
 * Tolerantly pull a single worktree out of a `worktree create` result: it
 * may be a bare worktree object, wrapped under `worktree`, or the first
 * element of a `worktrees` array — Herdr uses different shapes in different
 * places, and this normalizer is not meant to be an exhaustive schema, only
 * to survive whichever of the three actually comes back.
 */
export function extractWorktree(d: unknown): NormalizedWorktree {
  if (!d || typeof d !== "object") return {};
  const o = d as Record<string, unknown>;
  if (Array.isArray(o.worktrees) && o.worktrees.length) {
    return normalizeWorktree(o.worktrees[0]);
  }
  if (o.worktree && typeof o.worktree === "object") {
    return normalizeWorktree(o.worktree);
  }
  return normalizeWorktree(o);
}
