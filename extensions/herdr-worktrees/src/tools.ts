/**
 * The two tools this extension registers. Neither overrides a built-in tool
 * — see the package README's "What this extension must not do" section.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runHerdr } from "./herdr-cli.ts";
import { errorResult, okResult } from "./tool-result.ts";
import { createWorktreeArgs, extractWorktree } from "./worktree-create.ts";
import {
  type ResolveDeps,
  resolveWorktreePath,
  type WorktreePathErrorCode,
} from "./worktree-path.ts";

type PathErrorDetails = { error: { code: WorktreePathErrorCode; message: string } };
type PathOkDetails = {
  repoRoot: string;
  repoName: string;
  worktreesDir: string;
  path: string;
  branch: string;
  slug: string;
  mounted: true;
};
type PathDetails = PathOkDetails | PathErrorDetails;

const pathParams = Type.Object({
  repo: Type.Optional(
    Type.String({
      description:
        "Path inside the repo to resolve worktrees for (default: cwd). " +
        "Resolved to its repo root via `git rev-parse --show-toplevel`.",
    }),
  ),
  branch: Type.String({
    description: "Branch name; slugified for the directory component.",
  }),
});

/**
 * `herdr_devc_worktree_path` — pure (no writes, no Herdr call): derive where
 * a worktree for `branch` would go under this host's `<repo>.worktrees/`
 * sibling convention, and confirm it is safe to create there.
 */
export function registerWorktreePathTool(
  pi: ExtensionAPI,
  deps: ResolveDeps,
): void {
  pi.registerTool(
    defineTool<typeof pathParams, PathDetails>({
      name: "herdr_devc_worktree_path",
      label: "Resolve devcontainer worktree path",
      description:
        "Resolve where a Git worktree for `branch` would be created under this " +
        "host's devcontainer convention — a `<repo>.worktrees/<slug>` sibling " +
        "directory next to the repo, NOT Herdr's own `worktrees.directory` " +
        "layout. Does not create anything. Verifies the `.worktrees` sibling " +
        "is bind-mounted (inside a container) before returning success, because " +
        "Herdr silently `mkdir -p`s a missing parent and reports success even " +
        "when the result is invisible to the host. Call this before " +
        "`herdr_devc_worktree_create`, or to explain a NOT_A_MOUNT failure from it.",
      promptSnippet:
        "Resolve the devcontainer-convention worktree path for a branch, and check it's safe",
      promptGuidelines: [
        "Use herdr_devc_worktree_path before herdr_devc_worktree_create to see " +
          "the derived path and catch NOT_A_MOUNT / PATH_EXISTS without creating anything.",
        "NOT_A_MOUNT means the repo's `<repo>.worktrees` sibling isn't bind-mounted " +
          "into this container — fix with a mount in .devc/devc.jsonc (devc config), not by retrying.",
      ],
      parameters: pathParams,
      async execute(_id, params) {
        const result = resolveWorktreePath(
          { repo: params.repo, branch: params.branch },
          process.cwd(),
          deps,
        );
        if (!result.ok) {
          return errorResult(`${result.code}: ${result.message}`, {
            error: { code: result.code, message: result.message },
          });
        }
        return okResult(
          `Worktree for '${result.branch}' would be created at ${result.path}.`,
          {
            repoRoot: result.repoRoot,
            repoName: result.repoName,
            worktreesDir: result.worktreesDir,
            path: result.path,
            branch: result.branch,
            slug: result.slug,
            mounted: result.mounted,
          },
        );
      },
    }),
  );
}

type CreateOkDetails = {
  path: string;
  branch: string;
  label: string;
  openWorkspaceId: string | undefined;
  repoRoot: string;
};
type CreateErrorDetails = PathErrorDetails | { error: { code: "HERDR_FAILED"; message: string } };
type CreateDetails = CreateOkDetails | CreateErrorDetails;

const createParams = Type.Object({
  repo: Type.Optional(
    Type.String({
      description: "Path inside the repo to create the worktree from (default: cwd).",
    }),
  ),
  branch: Type.String({ description: "Branch name for the new worktree." }),
  label: Type.Optional(
    Type.String({
      description: "Label for the opened workspace (default: '<repoName>:<branch>').",
    }),
  ),
  base: Type.Optional(
    Type.String({ description: "Git ref to base the new branch on (e.g. 'main', a SHA)." }),
  ),
  focus: Type.Optional(
    Type.Boolean({
      description: "Focus the opened workspace (default false — background work).",
    }),
  ),
});

/**
 * `herdr_devc_worktree_create` — resolve via `herdr_devc_worktree_path`'s
 * logic, and only on success shell out to `herdr worktree create`. Any path
 * error is returned unchanged; nothing is created when the guard fires.
 */
export function registerWorktreeCreateTool(
  pi: ExtensionAPI,
  deps: ResolveDeps,
): void {
  pi.registerTool(
    defineTool<typeof createParams, CreateDetails>({
      name: "herdr_devc_worktree_create",
      label: "Create devcontainer worktree",
      description:
        "Create a Git worktree for `branch` under this host's devcontainer " +
        "convention (a `<repo>.worktrees/<slug>` sibling directory, not Herdr's " +
        "own worktrees.directory layout) and open it as a Herdr workspace. " +
        "Derives and guards the path exactly like `herdr_devc_worktree_path` " +
        "(same NOT_A_MOUNT / NOT_A_REPO / PATH_EXISTS errors — nothing is " +
        "created when the guard fires) and defaults to --no-focus so background " +
        "work doesn't steal the human's focus. Delegate an agent into the " +
        "returned `path` next (e.g. herdr_delegate's `cwd`).",
      promptSnippet:
        "Create and open a Git worktree under the devcontainer .worktrees convention",
      promptGuidelines: [
        "Use herdr_devc_worktree_create instead of pi-herdr's herdr_worktree_create " +
          "for repos following the <repo>.worktrees/<branch> sibling convention — " +
          "it derives --path and guards against an unmounted target.",
        "Defaults to --no-focus; pass focus:true only when the human should be " +
          "switched to the new workspace immediately.",
      ],
      parameters: createParams,
      async execute(_id, params, signal) {
        const resolved = resolveWorktreePath(
          { repo: params.repo, branch: params.branch },
          process.cwd(),
          deps,
        );
        if (!resolved.ok) {
          return errorResult(`${resolved.code}: ${resolved.message}`, {
            error: { code: resolved.code, message: resolved.message },
          });
        }

        const label = params.label ?? `${resolved.repoName}:${params.branch}`;
        const args = createWorktreeArgs({
          repoRoot: resolved.repoRoot,
          branch: params.branch,
          path: resolved.path,
          base: params.base,
          label,
          focus: params.focus ?? false,
        });

        const r = await runHerdr<unknown>(args, { timeoutMs: 60_000, signal });
        if (!r.ok) {
          return errorResult(`HERDR_FAILED: ${r.message}`, {
            error: { code: "HERDR_FAILED" as const, message: r.message },
          });
        }

        const w = extractWorktree(r.data);
        const path = w.path ?? resolved.path;
        const branch = w.branch ?? params.branch;
        // Not `w.label`: verified live that Herdr's `worktree.label` in the
        // create/list response is its own per-repo default (== repoName),
        // unrelated to the `--label` we just passed for the *workspace* —
        // echoing it back here would silently discard the caller's label.
        return okResult(
          `Created worktree on '${branch}' at ${path}` +
            (w.openWorkspaceId ? ` (workspace ${w.openWorkspaceId}).` : "."),
          {
            path,
            branch,
            label,
            openWorkspaceId: w.openWorkspaceId,
            repoRoot: resolved.repoRoot,
          },
        );
      },
    }),
  );
}

export function registerHerdrWorktreeTools(
  pi: ExtensionAPI,
  deps: ResolveDeps,
): void {
  registerWorktreePathTool(pi, deps);
  registerWorktreeCreateTool(pi, deps);
}
