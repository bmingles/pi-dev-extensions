/**
 * Five host-side tools that let a pi orchestrator running on the HOST, alongside a HOST
 * Herdr, fan agents out INTO the devcontainer this extension already routes into
 * (topology 1b — see `devc-dev/docs/herdr-host-orchestrator.md`). The day-to-day workflow —
 * branch naming, model selection, the Copilot trust overlay, `detected` vs `ready`, driving
 * and cleaning up a pane — is written up in this package's `devcontainer-agent-fleet` skill;
 * these doc comments stay focused on what each tool does and why.
 *
 * ⚠️ These are **not** `extensions/herdr-worktrees`' `herdr_devc_*` tools. Those run
 * container-side, from a pi inside the container, against a container Herdr. These run
 * host-side. The two can never load in one process, but the names must stay unconfusable in
 * docs, skills and a grep — hence the mirrored-but-distinct `devcontainer_herdr_*` prefix.
 *
 * Every tool here returns **both** `hostPath` and `containerPath`, never a bare `path`: an
 * orchestrator that loads this extension holds both vocabularies at once (its own
 * `read`/`bash` speak container paths, Herdr's worktree and workspace surfaces speak host
 * paths), and that is the single most likely source of a confusing failure.
 *
 * These tools override nothing. They stay outside the `ROUTING_MARKER_KEY` mutual-exclusion
 * mechanism in `index.ts`, which is specifically about overriding the same built-ins.
 */

import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createWorktreeArgs,
  expandTilde,
  extractWorktree,
  type HerdrResult,
  type RunHerdrOpts,
  slugify,
} from "pi-extension-herdr-core";
import { errorResult, okResult, type ToolResultWithError } from "pi-extension-core";
import type { ContainerMount, WorktreeInfo } from "@devc-tools/core";
import { hostToContainerPath } from "@devc-tools/core";
import type { ContainerInfo } from "./container.ts";
import {
  type AgentCommandLineOpts,
  buildAgentCommandLine,
  buildAgentCommandLineViaDevc,
  commandForAgentKind,
  extractFirstPaneId,
  extractPaneId,
  modelFlagForAgentKind,
  paneSplitArgs,
} from "./herdr-launch.ts";
import {
  type HerdrPathDeps,
  type HerdrPathErrorCode,
  type HerdrWorktreePathOk,
  resolveHerdrWorktreePath,
} from "./herdr-paths.ts";

/** How long to wait for Herdr to notice an agent in the new pane, and how often to ask. */
const AGENT_DETECT_BUDGET_MS = 20_000;
const AGENT_DETECT_INTERVAL_MS = 500;

export type HerdrToolErrorCode =
  | HerdrPathErrorCode
  | "CONTAINER_UNAVAILABLE"
  | "HERDR_FAILED"
  | "ABSOLUTE_GITDIR"
  | "PANE_GONE"
  | "AGENT_NOT_DETECTED"
  | "DEVC_LAUNCHER_UNAVAILABLE"
  | "MODEL_UNSUPPORTED"
  | "BRANCH_OR_PURPOSE_REQUIRED"
  | "DERIVED_BRANCH_EXHAUSTED";

type ErrorDetails = {
  error: { code: HerdrToolErrorCode; message: string };
};

function fail<T extends ErrorDetails>(
  code: HerdrToolErrorCode,
  message: string,
): ToolResultWithError<T> {
  return errorResult(`${code}: ${message}`, {
    error: { code, message },
  } as T);
}

/**
 * The `pane run` command line builder, as a seam. `index.ts` wires this to
 * `buildAgentCommandLineAuto` (auto-detect between the `docker` and `devc` forms) for the
 * real extension; defaults to the `docker` form here when unset, which is what every test
 * harness that doesn't care about the launcher gets for free.
 *
 * The `devc` variant (`buildAgentCommandLineViaDevc` in `herdr-launch.ts`) buys
 * `TERM`/`TERM_PROGRAM`/`TMUX` propagation, the attach tint, and identity rotation if a human
 * takes the pane over, for the three kinds `devc` has a dedicated subcommand for
 * (claude/copilot/pi) — it needs `devc` on PATH, which this extension's stated requirements
 * still do not (it stays optional; see the README's Requirements section).
 */
export type LaunchCommandBuilder = (opts: AgentCommandLineOpts) => string;

/** Everything these tools need from the outside world, injected so they test headlessly. */
export interface HerdrToolDeps extends HerdrPathDeps {
  /** pi's host cwd, captured at extension load. */
  hostCwd: string;
  /**
   * The extension's single container anchor. Never throws — a declined home-directory
   * confirmation or an infra failure comes back as a message, which becomes
   * `CONTAINER_UNAVAILABLE`.
   */
  ensureContainer(
    ctx?: ExtensionContext,
  ): Promise<
    { ok: true; info: ContainerInfo } | { ok: false; message: string }
  >;
  /** The container's mount table — `docker inspect`, host-side, via core. */
  getMounts(hostCwd: string): Promise<ContainerMount[]>;
  runHerdr<T>(
    args: string[],
    opts?: RunHerdrOpts,
  ): Promise<HerdrResult<T>>;
  /** Core's `resolveWorktree`, bound to a real filesystem probe. */
  resolveWorktree(hostPath: string): Promise<WorktreeInfo>;
  /** Injected so the agent-detection poll runs instantly under test. */
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Defaults to the `docker exec` form. See {@link LaunchCommandBuilder}. */
  buildCommandLine?: LaunchCommandBuilder;
  /**
   * Whether a `devc` binary resolved on `PATH` at extension load. Used only to give the
   * explicit `launcher: "devc"` override (`startParams`) a precise error when `devc` isn't
   * installed — `buildAgentCommandLineViaDevc` alone can't distinguish "no devc on PATH"
   * from "kind not covered by devc", and an explicit request deserves the right answer.
   * Auto-detect doesn't consult this: PATH resolution is already baked into `buildCommandLine`
   * at the `index.ts` construction site. Defaults to `false`.
   */
  devcAvailable?: boolean;
}

/** Resolve the container and its mount table in one step, or the error that stopped us. */
async function anchor(
  deps: HerdrToolDeps,
  ctx?: ExtensionContext,
): Promise<
  | { ok: true; info: ContainerInfo; mounts: ContainerMount[] }
  | { ok: false; code: HerdrToolErrorCode; message: string }
> {
  const resolved = await deps.ensureContainer(ctx);
  if (!resolved.ok) {
    return { ok: false, code: "CONTAINER_UNAVAILABLE", message: resolved.message };
  }
  try {
    return {
      ok: true,
      info: resolved.info,
      mounts: await deps.getMounts(deps.hostCwd),
    };
  } catch (err) {
    return {
      ok: false,
      code: "CONTAINER_UNAVAILABLE",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Whether `agentArgs` already spells out `--model` (bare or `--model=value`). */
function agentArgsHasModelFlag(agentArgs: string[] | undefined): boolean {
  return (agentArgs ?? []).some((a) => a === "--model" || a.startsWith("--model="));
}

/**
 * Resolve the `model` parameter against `agentArgs`'s own precedence and `agent`'s known
 * flag, before a command line is ever built. Three outcomes:
 *
 * - No `model` requested → `{ ok: true, model: undefined }`, nothing to say.
 * - `model` requested, but `agentArgs` already spells out `--model` → the explicit
 *   `agentArgs` wins; `model` is dropped, and `note` says so (never silently — two `--model`
 *   flags is a CLI error on most agents, and it isn't this function's job to guess which one
 *   the caller meant).
 * - `model` requested, no flag known for `agent` → `MODEL_UNSUPPORTED`, naming the kind.
 */
function resolveModelPrecedence(
  agent: string,
  model: string | undefined,
  agentArgs: string[] | undefined,
): { ok: true; model: string | undefined; note?: string } | {
  ok: false;
  code: "MODEL_UNSUPPORTED";
  message: string;
} {
  if (!model) return { ok: true, model: undefined };
  if (agentArgsHasModelFlag(agentArgs)) {
    return {
      ok: true,
      model: undefined,
      note: `model: '${model}' was ignored because agentArgs already spells out --model — ` +
        "an explicit agentArgs flag always wins, and emitting both would be a CLI error.",
    };
  }
  if (!modelFlagForAgentKind(agent)) {
    return {
      ok: false,
      code: "MODEL_UNSUPPORTED",
      message: `No known model flag for agent kind '${agent}'. Pass the flag that kind's ` +
        "CLI understands directly in agentArgs instead, or omit model.",
    };
  }
  return { ok: true, model };
}

// ---------------------------------------------------------------------------
// devcontainer_herdr_worktree_path
// ---------------------------------------------------------------------------

const pathParams = Type.Object({
  repo: Type.Optional(
    Type.String({
      description:
        "HOST path inside the repo to resolve worktrees for (default: pi's host cwd). " +
        "Resolved to its repo root via `git rev-parse --show-toplevel` on the host.",
    }),
  ),
  branch: Type.String({
    description: "Branch name; slugified for the directory component.",
  }),
});

type PathOkDetails = {
  repoRoot: string;
  repoName: string;
  worktreesDir: string;
  hostPath: string;
  containerPath: string;
  branch: string;
  slug: string;
  mount: { source: string; destination: string };
};
type PathDetails = PathOkDetails | ErrorDetails;

export function registerWorktreePathTool(
  pi: ExtensionAPI,
  deps: HerdrToolDeps,
): void {
  pi.registerTool(
    defineTool<typeof pathParams, PathDetails>({
      name: "devcontainer_herdr_worktree_path",
      label: "Resolve container-visible worktree path",
      description:
        "Resolve where a Git worktree for `branch` would be created on the HOST under the " +
        "`<repo>.worktrees/<slug>` sibling convention, and return the CONTAINER path that " +
        "corresponds to it. Creates nothing and never calls herdr. Fails with " +
        "NOT_MOUNTED_IN_CONTAINER when no bind mount of the routed container covers the " +
        "derived path — a checkout there would be invisible to any container agent. Call " +
        "this before devcontainer_herdr_worktree_create, or to explain its failure.",
      promptSnippet:
        "Resolve a host worktree path and its container equivalent, without creating anything",
      promptGuidelines: [
        "Use devcontainer_herdr_worktree_path before devcontainer_herdr_worktree_create to " +
          "see the derived paths and catch NOT_MOUNTED_IN_CONTAINER / PATH_EXISTS without " +
          "creating anything.",
        "NOT_MOUNTED_IN_CONTAINER means the repo's `<repo>.worktrees` sibling isn't bind-mounted " +
          "into the container — fix it with a mount in .devc/devc.jsonc (devc config) and a " +
          "rebuild, not by retrying.",
      ],
      parameters: pathParams,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const a = await anchor(deps, ctx);
        if (!a.ok) return fail<PathDetails & ErrorDetails>(a.code, a.message);

        const result = resolveHerdrWorktreePath(
          { repo: params.repo, branch: params.branch },
          deps.hostCwd,
          a.mounts,
          deps,
        );
        if (!result.ok) {
          return fail<PathDetails & ErrorDetails>(result.code, result.message);
        }
        return okResult(
          `Worktree for '${result.branch}' would be created at ${result.hostPath} ` +
            `(host), visible to the container at ${result.containerPath}.`,
          {
            repoRoot: result.repoRoot,
            repoName: result.repoName,
            worktreesDir: result.worktreesDir,
            hostPath: result.hostPath,
            containerPath: result.containerPath,
            branch: result.branch,
            slug: result.slug,
            mount: result.mount,
          },
        );
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// devcontainer_herdr_worktree_create
// ---------------------------------------------------------------------------

const createParams = Type.Object({
  repo: Type.Optional(
    Type.String({
      description: "HOST path inside the repo to create the worktree from (default: pi's host cwd).",
    }),
  ),
  branch: Type.Optional(
    Type.String({
      description:
        "Branch name for the new worktree. An explicit branch that collides with an " +
        "existing path fails with PATH_EXISTS — it is never silently changed. Omit and pass " +
        "`purpose` instead to have a branch name derived and disambiguated automatically. " +
        "One of `branch` or `purpose` is required.",
    }),
  ),
  purpose: Type.Optional(
    Type.String({
      description:
        "What the worktree is for, in a few words (e.g. 'fix the flaky retry test'). Used " +
        "to derive a branch name (`agent/<slugified-purpose>`) when `branch` is not given. " +
        "A collision with an existing path is disambiguated with a numeric suffix " +
        "(-2, -3, … up to -9) rather than failing outright — unlike an explicit `branch`. " +
        "The derived name is always reported back in the result; never assume it.",
    }),
  ),
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

type CreateOkDetails = {
  hostPath: string;
  containerPath: string;
  branch: string;
  label: string;
  openWorkspaceId: string | undefined;
  repoRoot: string;
};
type CreateDetails = CreateOkDetails | ErrorDetails;

type CreateParams = {
  repo?: string;
  branch?: string;
  purpose?: string;
  label?: string;
  base?: string;
  focus?: boolean;
};

type CreateCoreResult =
  | { ok: true; details: CreateOkDetails; text: string }
  | { ok: false; code: HerdrToolErrorCode; message: string };

/** Up to 9 derived-name attempts: the bare purpose slug, then `-2` through `-9`. */
const MAX_DERIVED_BRANCH_ATTEMPTS = 9;

/**
 * The shared body of `devcontainer_herdr_worktree_create` and
 * `devcontainer_herdr_start_worktree_agent`'s create half — factored out so the composite
 * tool doesn't reimplement (or drift from) branch derivation, the path guards, or the
 * ABSOLUTE_GITDIR check.
 */
async function createWorktreeCore(
  params: CreateParams,
  deps: HerdrToolDeps,
  mounts: ContainerMount[],
  signal: AbortSignal | undefined,
): Promise<CreateCoreResult> {
  if (!params.branch && !params.purpose) {
    return {
      ok: false,
      code: "BRANCH_OR_PURPOSE_REQUIRED",
      message: "Pass either `branch` (an explicit name) or `purpose` (a few words to derive " +
        "one from) — two names for the same worktree is worse than asking.",
    };
  }

  // An explicit `branch` is tried exactly once — a collision is PATH_EXISTS, full stop, so
  // it is never silently changed. A `purpose`-derived one is tried with numeric suffixes,
  // because a derived name exists precisely so unattended work doesn't stop on a collision.
  const candidates = params.branch
    ? [params.branch]
    : Array.from(
      { length: MAX_DERIVED_BRANCH_ATTEMPTS },
      (_, i) => {
        const base = `agent/${slugify(params.purpose!)}`;
        return i === 0 ? base : `${base}-${i + 1}`;
      },
    );

  let resolved: HerdrWorktreePathOk | undefined;
  for (const candidate of candidates) {
    const attempt = resolveHerdrWorktreePath(
      { repo: params.repo, branch: candidate },
      deps.hostCwd,
      mounts,
      deps,
    );
    if (attempt.ok) {
      resolved = attempt;
      break;
    }
    // An explicit `branch` (the single-candidate case) surfaces whatever it failed with —
    // PATH_EXISTS included — exactly as before this plan: an explicit collision is an error,
    // never silently changed. For a `purpose`-derived name, only PATH_EXISTS is worth
    // retrying with the next suffix; NOT_A_REPO / NOT_MOUNTED_IN_CONTAINER are structural, so
    // fail immediately rather than burning through every suffix for nothing.
    if (params.branch || attempt.code !== "PATH_EXISTS") {
      return { ok: false, code: attempt.code, message: attempt.message };
    }
  }
  if (!resolved) {
    return {
      ok: false,
      code: "DERIVED_BRANCH_EXHAUSTED",
      message: `Every derived branch name from purpose '${params.purpose}' (tried ` +
        `${candidates.length}, from '${candidates[0]}' to '${candidates.at(-1)}') already ` +
        "has a worktree path on the host. Pass an explicit `branch` instead.",
    };
  }

  const branchToCreate = resolved.branch;
  const label = params.label ?? `${resolved.repoName}:${branchToCreate}`;
  // Herdr runs on the host in this topology, so `--cwd` and `--path` are both host
  // paths. `--path` is always explicit: Herdr's `worktrees.directory` composes
  // `<root>/<repo>/<branch-slug>` under one global root and cannot express a sibling
  // layout, so the default would be wrong outright, not merely suboptimal.
  const r = await deps.runHerdr<unknown>(
    createWorktreeArgs({
      repoRoot: resolved.repoRoot,
      branch: branchToCreate,
      path: resolved.hostPath,
      base: params.base,
      label,
      focus: params.focus ?? false,
    }),
    { timeoutMs: 60_000, signal },
  );
  if (!r.ok) {
    return { ok: false, code: "HERDR_FAILED", message: r.message };
  }

  // The invariant the whole topology rests on, asserted at the one point that can see
  // it. `devc-core`'s own check runs in the `devc config` mount picker, over worktrees
  // that already exist — it never sees one created dynamically like this.
  const wt = await deps.resolveWorktree(resolved.hostPath);
  if (wt.isWorktree && !wt.valid) {
    return {
      ok: false,
      code: "ABSOLUTE_GITDIR",
      message: `The worktree at ${resolved.hostPath} has an absolute 'gitdir:' link, which ` +
        "names a host path that does not exist inside the container — the agent " +
        "could not use the checkout. Set `worktree.useRelativePaths=true` on the " +
        "HOST git (git >= 2.48), then remove this worktree " +
        "(`git worktree remove --force`) and create it again. Retrying this tool " +
        "will not help.",
    };
  }

  const w = extractWorktree(r.data);
  // Deliberately not `w.path`: a create response echoes `--path` back unnormalized
  // while `worktree list` normalizes it, so the two are not comparable and only the
  // path we derived is known-normalized.
  const branch = w.branch ?? branchToCreate;
  // Deliberately not `w.label`: verified live that Herdr's `worktree.label` is its own
  // per-repo default (== repoName), unrelated to the `--label` just passed.
  return {
    ok: true,
    text: `Created worktree on '${branch}' at ${resolved.hostPath} (host), visible to the ` +
      `container at ${resolved.containerPath}` +
      (w.openWorkspaceId ? ` (workspace ${w.openWorkspaceId}).` : "."),
    details: {
      hostPath: resolved.hostPath,
      containerPath: resolved.containerPath,
      branch,
      label,
      openWorkspaceId: w.openWorkspaceId,
      repoRoot: resolved.repoRoot,
    },
  };
}

export function registerWorktreeCreateTool(
  pi: ExtensionAPI,
  deps: HerdrToolDeps,
): void {
  pi.registerTool(
    defineTool<typeof createParams, CreateDetails>({
      name: "devcontainer_herdr_worktree_create",
      label: "Create container-visible worktree",
      description:
        "Create a Git worktree on the HOST under the `<repo>.worktrees/<slug>` sibling " +
        "convention and open it as a Herdr workspace. Pass `branch` for an explicit name " +
        "(collides with PATH_EXISTS, never silently changed) or `purpose` to derive one as " +
        "`agent/<slug>` (collisions disambiguated with -2..-9). Derives and guards the path " +
        "exactly like devcontainer_herdr_worktree_path (same NOT_A_REPO / " +
        "NOT_MOUNTED_IN_CONTAINER errors — nothing is created when a guard fires) and " +
        "additionally verifies the new checkout's .git link is RELATIVE, since an absolute " +
        "one names a host path that does not resolve inside the container. Defaults to " +
        "--no-focus. Launch an agent next with devcontainer_herdr_start_agent, passing this " +
        "result's `hostPath` and `openWorkspaceId` (as `workspaceId`) — or use " +
        "devcontainer_herdr_start_worktree_agent to do both in one call.",
      promptSnippet:
        "Create a Git worktree the devcontainer can see, and open it as a Herdr workspace",
      promptGuidelines: [
        "Prefer devcontainer_herdr_start_worktree_agent over calling " +
          "devcontainer_herdr_worktree_create and devcontainer_herdr_start_agent " +
          "separately, unless you need to inspect or adjust the worktree before an agent " +
          "starts in it.",
        "Use devcontainer_herdr_worktree_create instead of pi-herdr's herdr_worktree_create " +
          "when the agent that will work in the checkout runs inside the devcontainer — it " +
          "derives --path and guards against a target the container cannot see.",
        "Pass `purpose` (not an invented branch name) when the caller hasn't specified one — " +
          "the derived `agent/<slug>` name is always reported back in the result.",
        "ABSOLUTE_GITDIR is not retryable: remove the created worktree, set " +
          "worktree.useRelativePaths=true on the HOST git (git >= 2.48), and create it again.",
        "Chain straight into devcontainer_herdr_start_agent with hostPath and " +
          "openWorkspaceId (as workspaceId) — that is the first-class create-then-attach " +
          "path and leaves no idle pane behind.",
      ],
      parameters: createParams,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const a = await anchor(deps, ctx);
        if (!a.ok) return fail<CreateDetails & ErrorDetails>(a.code, a.message);

        const r = await createWorktreeCore(params, deps, a.mounts, signal);
        if (!r.ok) return fail<CreateDetails & ErrorDetails>(r.code, r.message);
        return okResult(r.text, r.details);
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// devcontainer_herdr_start_agent
// ---------------------------------------------------------------------------

const startParams = Type.Object({
  name: Type.Optional(
    Type.String({ description: "Pane/agent name (default: 'agent-<timestamp>')." }),
  ),
  agent: Type.Optional(
    Type.String({
      description:
        "Herdr agent kind to assert via HERDR_AGENT (default: 'claude'). Note this is " +
        "deliberately NOT pi-herdr's default of 'pi': 'claude' is the kind the docker exec " +
        "launch was verified end-to-end against, and the one the devcontainer's agents " +
        "Feature installs by default.",
    }),
  ),
  command: Type.Optional(
    Type.String({
      description:
        "Executable to run inside the container (default: derived from `agent`, which " +
        "Herdr documents as the canonical executable for a kind).",
    }),
  ),
  agentArgs: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Arguments appended after the executable. Note shift+tab does not survive " +
        "docker exec -it, so pass an explicit --permission-mode rather than relying on it.",
    }),
  ),
  hostPath: Type.Optional(
    Type.String({
      description:
        "HOST directory for the agent's cwd, translated to the container path (default: " +
        "pi's host cwd). Pass what devcontainer_herdr_worktree_create returned. Still used " +
        "for the container-path translation even when `workspaceId` is also passed.",
    }),
  ),
  workspaceId: Type.Optional(
    Type.String({
      description:
        "Run in the pane already open in this Herdr workspace instead of splitting a new " +
        "one off pi's own pane — pass the `openWorkspaceId` devcontainer_herdr_worktree_create " +
        "returned. This is the low-ceremony create-then-attach path: it lands the agent in " +
        "the pane `worktree_create` already opened (which would otherwise sit idle) rather " +
        "than leaving that pane idle and splitting a second, unrelated one, and it ties the " +
        "agent's pane to Herdr's own worktree<->workspace lifecycle, so removing the " +
        "worktree (herdr_worktree_remove) closes this pane too instead of orphaning it. " +
        "`split`/`focus` are ignored when this is passed.",
    }),
  ),
  split: Type.Optional(
    Type.Union([Type.Literal("right"), Type.Literal("down")], {
      description:
        "Split direction for the new pane (default: 'right'). Ignored when `workspaceId` " +
        "is passed.",
    }),
  ),
  focus: Type.Optional(
    Type.Boolean({
      description:
        "Focus the new pane (default false — background work). Ignored when `workspaceId` " +
        "is passed.",
    }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Extra environment variables, passed as `-e K=V` on the docker exec.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Model for the agent's own CLI (e.g. 'sonnet', 'opus'). Translated to that kind's " +
        "own flag (currently known for claude/copilot/pi — see herdr-launch.ts's " +
        "modelFlagForAgentKind). This is NOT the Herdr agent kind — see `agent`. Fails with " +
        "MODEL_UNSUPPORTED for a kind with no known model flag rather than silently " +
        "ignoring it. An explicit `--model` already present in `agentArgs` wins over this " +
        "and this is dropped instead — stated in the result, never silently — since two " +
        "--model flags is a CLI error on most agents.",
    }),
  ),
  waitForReady: Type.Optional(
    Type.Boolean({
      description:
        "Poll for the kind's own 'ready to accept input' pane pattern, beyond Herdr merely " +
        "detecting an agent, and report it as `startupState: 'ready'`. Default false. No " +
        "kind currently has a known ready pattern (see herdr-launch.ts's " +
        "readyPatternForAgentKind), so this presently always resolves to 'unknown' rather " +
        "than 'ready' — `detected` (Herdr matched a process rule) is not the same claim as " +
        "`ready` (the agent is actually accepting input); do not treat one as the other.",
    }),
  ),
  launcher: Type.Optional(
    Type.Union([Type.Literal("docker"), Type.Literal("devc")], {
      description:
        "Force a specific pane command line instead of auto-detecting (default). 'docker' " +
        "is the raw `docker exec` form (always available). 'devc' routes through " +
        "`devc <kind> --cwd <containerPath>` instead, which only `claude`/`copilot`/`pi` " +
        "have a dedicated subcommand for and which has no way to pass `env` — an explicit " +
        "'devc' errors (rather than silently falling back to 'docker') if `devc` isn't on " +
        "PATH, `agent` isn't one of those three, or `env` is set.",
    }),
  ),
});

type StartOkDetails = {
  paneId: string;
  reusedWorkspaceId: string | undefined;
  name: string;
  agent: string;
  hostPath: string;
  containerPath: string;
  containerId: string;
  /**
   * `"detected"`: Herdr's own `agent get` poll matched — a process rule fired, nothing more.
   * `"ready"`: additionally confirmed against the kind's own ready pattern (only when
   * `waitForReady` was passed and a pattern is known — see `readyPatternForAgentKind`).
   * `"unknown"`: `waitForReady` was passed but no pattern is known for this kind, so
   * readiness could not be checked either way — never fabricated from a timeout.
   */
  startupState: "detected" | "ready" | "unknown";
};
type StartDetails = StartOkDetails | ErrorDetails;

type StartParams = {
  name?: string;
  agent?: string;
  command?: string;
  agentArgs?: string[];
  hostPath?: string;
  workspaceId?: string;
  split?: "right" | "down";
  focus?: boolean;
  env?: Record<string, string>;
  model?: string;
  waitForReady?: boolean;
  launcher?: "docker" | "devc";
};

type StartCoreResult =
  | { ok: true; details: StartOkDetails; text: string }
  | { ok: false; code: HerdrToolErrorCode; message: string };

/**
 * The shared body of `devcontainer_herdr_start_agent` and
 * `devcontainer_herdr_start_worktree_agent`'s start half. `info`/`mounts` are the caller's
 * already-resolved anchor (see `anchor()`) — factored out as parameters rather than calling
 * `anchor` again here, so the composite tool resolves the container exactly once for both
 * halves.
 */
async function startAgentCore(
  params: StartParams,
  deps: HerdrToolDeps,
  info: ContainerInfo,
  mounts: ContainerMount[],
  signal: AbortSignal | undefined,
): Promise<StartCoreResult> {
  const buildCommandLine = deps.buildCommandLine ?? buildAgentCommandLine;

  // Same reason as `repo` in herdr-paths.ts: a model writes `~/...` and no shell
  // is in the loop to expand it.
  const hostPath = params.hostPath
    ? expandTilde(params.hostPath, deps.homedir)
    : deps.hostCwd;
  const containerPath = hostToContainerPath(hostPath, mounts);
  if (containerPath === null) {
    return {
      ok: false,
      code: "NOT_MOUNTED_IN_CONTAINER",
      message: `'${hostPath}' is not covered by any bind mount of this container, so an ` +
        "agent inside it has no path for that directory and cannot start there. " +
        "Add a mount for it in `.devc/devc.jsonc` (via `devc config`) and rebuild.",
    };
  }

  const agent = params.agent ?? "claude";
  const name = params.name ?? `agent-${Date.now()}`;

  const modelResolution = resolveModelPrecedence(agent, params.model, params.agentArgs);
  if (!modelResolution.ok) {
    return { ok: false, code: modelResolution.code, message: modelResolution.message };
  }

  let paneId: string | undefined;
  if (params.workspaceId) {
    // Retarget into the pane `worktree_create` already opened, instead of splitting a
    // second one off pi's own pane. That pane's cwd is already the worktree's host
    // path — Herdr set it when the workspace opened — so there is no `--cwd` to pass
    // here, and this pane's lifecycle is Herdr's own worktree<->workspace tie, not
    // ours: `herdr_worktree_remove` closes it along with the workspace.
    const list = await deps.runHerdr<unknown>(
      ["pane", "list", "--workspace", params.workspaceId],
      { signal },
    );
    if (!list.ok) {
      return { ok: false, code: "HERDR_FAILED", message: list.message };
    }
    paneId = extractFirstPaneId(list.data);
    if (!paneId) {
      return {
        ok: false,
        code: "PANE_GONE",
        message: `Workspace ${params.workspaceId} has no pane to run in. Pass hostPath ` +
          "without workspaceId to split a new pane instead, or check the workspace id.",
      };
    }
  } else {
    // `--cwd` on the split is the HOST path: it sets the pane's own shell cwd, which
    // is what Herdr's Space and branch display key off. The container path goes to
    // the `docker exec` below instead.
    const split = await deps.runHerdr<unknown>(
      paneSplitArgs({
        direction: params.split ?? "right",
        hostPath,
        focus: params.focus ?? false,
      }),
      { signal },
    );
    if (!split.ok) {
      return { ok: false, code: "HERDR_FAILED", message: split.message };
    }
    paneId = extractPaneId(split.data);
    if (!paneId) {
      return {
        ok: false,
        code: "PANE_GONE",
        message: "herdr pane split reported success but returned no pane id.",
      };
    }
  }

  const cmdOpts: AgentCommandLineOpts = {
    agent,
    containerId: info.containerId,
    remoteUser: info.remoteUser,
    containerPath,
    command: params.command ?? commandForAgentKind(agent),
    agentArgs: params.agentArgs,
    env: params.env,
    model: modelResolution.model,
  };

  let commandLine: string;
  if (params.launcher === "docker") {
    commandLine = buildAgentCommandLine(cmdOpts);
  } else if (params.launcher === "devc") {
    if (!deps.devcAvailable) {
      return {
        ok: false,
        code: "DEVC_LAUNCHER_UNAVAILABLE",
        message: "launcher: 'devc' was requested, but no `devc` binary resolved on PATH at " +
          "extension load. Omit `launcher` for auto-detect (falls back to `docker` " +
          "automatically), or pass launcher: 'docker' explicitly.",
      };
    }
    const viaDevc = buildAgentCommandLineViaDevc(cmdOpts);
    if (viaDevc === null) {
      return {
        ok: false,
        code: "DEVC_LAUNCHER_UNAVAILABLE",
        message: `launcher: 'devc' was requested, but devc has no dedicated subcommand for ` +
          `agent kind '${agent}' (only claude/copilot/pi do), or 'env' was passed, ` +
          "which devc's launcher has no flag for. Pass launcher: 'docker' instead, " +
          "or drop env.",
      };
    }
    commandLine = viaDevc;
  } else {
    commandLine = buildCommandLine(cmdOpts);
  }
  // No `--json` (see the comment on `paneSplitArgs`), and `tolerateEmptySuccess`:
  // live-tested against a real host and found `pane run` exits 0 with *empty* stdout
  // on at least one Herdr build — no JSON envelope even without `--json` fighting it —
  // while the command it typed genuinely ran (the `docker exec` visibly attached in
  // the pane). Without the tolerance, that reads as `HERDR_FAILED` for a call that
  // actually worked. This is the one call in the flow where that's safe: `run.data` is
  // never read below, only whether the launch itself errored.
  const run = await deps.runHerdr<unknown>(
    ["pane", "run", paneId, commandLine],
    { signal, tolerateEmptySuccess: true },
  );
  if (!run.ok) {
    return { ok: false, code: "HERDR_FAILED", message: run.message };
  }

  // Herdr needs a moment to notice the agent in the pane. This is the same wait
  // pi-herdr's `waitForAgentDetected` does, and the step most likely to behave
  // differently for an *asserted* (rather than detected) container agent.
  const deadline = deps.now() + AGENT_DETECT_BUDGET_MS;
  let detected = false;
  for (;;) {
    // No `--json`: verified live (0.8.2) that `agent get` rejects it (a usage error,
    // exit 2) while its response is JSON either way. This is the more consequential of
    // the two fixed here — the old flag broke this poll on *every* call, and because
    // only `got.ok` is checked, it silently manufactured AGENT_NOT_DETECTED after the
    // full budget on every successful launch, never surfacing the real cause.
    const got = await deps.runHerdr<unknown>(
      ["agent", "get", paneId],
      { signal },
    );
    if (got.ok) {
      detected = true;
      break;
    }
    if (deps.now() >= deadline) break;
    await deps.sleep(AGENT_DETECT_INTERVAL_MS);
  }
  if (!detected) {
    return {
      ok: false,
      code: "AGENT_NOT_DETECTED",
      message: `Herdr did not report an agent in pane ${paneId} within ` +
        `${AGENT_DETECT_BUDGET_MS / 1000}s. The pane exists and the command was sent, ` +
        `so run \`herdr agent explain ${paneId}\` to see which detection rule (if any) ` +
        "matched, and check the pane for an auth prompt or a failed launch.",
    };
  }

  // Beyond "detected" (a process rule matched): does this kind have a known ready pattern to
  // poll for? `herdr-launch.ts`'s `readyPatternForAgentKind` table is empty for every kind
  // (see its own doc comment on why — Step 1.3 needs a live pane capture this environment
  // cannot provide), so there is nothing to poll yet: resolve straight to "unknown" rather
  // than burning the detect budget a second time waiting for a pattern that can never match,
  // and never fabricate "ready" from a timeout. Once a first pattern is measured and added to
  // that table, this is the seam a poll against `agent read <paneId>` hangs off — see the
  // plan's Step 6.2 for the shape it should take.
  const startupState: StartOkDetails["startupState"] = params.waitForReady
    ? "unknown"
    : "detected";

  // Best-effort, exactly as pi-herdr's Windows path treats it: a pane that works under
  // a generated name is better than a failed tool call. No `--json`: `agent rename`
  // rejects it the same way `agent get` does, and this call ignoring its own result
  // already means that failure was silent — worth knowing, not worth surfacing.
  await deps.runHerdr<unknown>(
    ["agent", "rename", paneId, name],
    { signal },
  );

  return {
    ok: true,
    text: `Started '${agent}' in pane ${paneId}` +
      (params.workspaceId ? ` (reused from workspace ${params.workspaceId})` : "") +
      `, running in the container at ${containerPath} (host ${hostPath}). Drive it ` +
      "with pi-herdr's herdr_send_prompt / herdr_wait_agent / herdr_read_agent using " +
      `paneId '${paneId}'. Trust 'working' and 'blocked'; 'idle' is a fallback that ` +
      "also covers 'not started yet'. Read the pane before reporting success to a human — " +
      `startupState '${startupState}' means Herdr detected a process, not that the agent ` +
      "has finished initializing." +
      (modelResolution.note ? ` ${modelResolution.note}` : ""),
    details: {
      reusedWorkspaceId: params.workspaceId,
      paneId,
      name,
      agent,
      hostPath,
      containerPath,
      containerId: info.containerId,
      startupState,
    },
  };
}

export function registerStartAgentTool(
  pi: ExtensionAPI,
  deps: HerdrToolDeps,
): void {
  pi.registerTool(
    defineTool<typeof startParams, StartDetails>({
      name: "devcontainer_herdr_start_agent",
      label: "Start a container agent in a Herdr pane",
      description:
        "Launch an agent INSIDE the routed devcontainer, with its cwd set to the container " +
        "path for `hostPath`. When `workspaceId` is passed (the `openWorkspaceId` " +
        "devcontainer_herdr_worktree_create returned), runs in the pane that workspace " +
        "already has rather than splitting a new one off pi's own pane — the first-class " +
        "create-then-attach path, with cleanup tied to Herdr's worktree removal. Without " +
        "it, splits a new pane on the HOST instead. Identity is asserted with HERDR_AGENT " +
        "rather than detected, so Herdr's working/blocked states remain trustworthy but " +
        "'idle' is a fallback that also covers 'not started yet' and 'stuck on an auth " +
        "prompt'. Returns a paneId — drive it afterwards with pi-herdr's " +
        "herdr_send_prompt / herdr_wait_agent / herdr_read_agent.",
      promptSnippet:
        "Launch an agent inside the devcontainer in a Herdr pane",
      promptGuidelines: [
        "Prefer devcontainer_herdr_start_worktree_agent when you also need a worktree — it " +
          "creates one and starts the agent in it in a single call.",
        "Pass the hostPath returned by devcontainer_herdr_worktree_create; the container " +
          "cwd is derived from it, so there is no host/container pair to keep in sync.",
        "Also pass its openWorkspaceId as workspaceId to land the agent in the pane " +
          "worktree_create already opened, instead of leaving that pane idle and splitting " +
          "a second, unrelated one — this is the low-ceremony create-then-attach path, and " +
          "it makes herdr_worktree_remove clean up the agent's pane too.",
        "Pass `model` (e.g. 'opus') for a structured model choice instead of hand-building " +
          "the flag in agentArgs; MODEL_UNSUPPORTED means that kind has no known flag — put " +
          "the flag directly in agentArgs instead.",
        "After a successful start, drive the pane with pi-herdr's herdr_send_prompt, " +
          "herdr_wait_agent and herdr_read_agent using the returned paneId.",
        "Trust `working` and `blocked`; treat `idle` as unknown. `startupState: 'detected'` " +
          "means Herdr matched a process, not that the agent finished initializing — read " +
          "the pane before reporting success to a human. If the agent never appears, " +
          "`herdr agent explain <paneId>` says which detection rule matched.",
        "Copilot's folder-trust overlay is a multi-choice prompt, not a text field: use " +
          "herdr_send_keys with arrow keys + Enter to clear it, never herdr_send_prompt — " +
          "typed text does not register on a multi-choice overlay.",
      ],
      parameters: startParams,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const a = await anchor(deps, ctx);
        if (!a.ok) return fail<StartDetails & ErrorDetails>(a.code, a.message);

        const r = await startAgentCore(params, deps, a.info, a.mounts, signal);
        if (!r.ok) return fail<StartDetails & ErrorDetails>(r.code, r.message);
        return okResult(r.text, r.details);
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// devcontainer_herdr_start_worktree_agent
// ---------------------------------------------------------------------------

const startWorktreeAgentParams = Type.Object({
  // From createParams (hostPath/openWorkspaceId are derived, not asked for).
  repo: createParams.properties.repo,
  branch: createParams.properties.branch,
  purpose: createParams.properties.purpose,
  label: createParams.properties.label,
  base: createParams.properties.base,
  focus: Type.Optional(
    Type.Boolean({
      description: "Focus the opened workspace/pane (default false — background work).",
    }),
  ),
  // From startParams (hostPath/workspaceId/split are derived from the create half).
  name: startParams.properties.name,
  agent: startParams.properties.agent,
  command: startParams.properties.command,
  agentArgs: startParams.properties.agentArgs,
  env: startParams.properties.env,
  model: startParams.properties.model,
  waitForReady: startParams.properties.waitForReady,
  launcher: startParams.properties.launcher,
});

type StartWorktreeAgentOkDetails = CreateOkDetails & Omit<StartOkDetails, "hostPath" | "containerPath">;
type StartWorktreeAgentDetails =
  | StartWorktreeAgentOkDetails
  | (ErrorDetails & {
    /** True only for the create-succeeded-start-failed case: the worktree was NOT rolled back. */
    worktreeCreated?: boolean;
    hostPath?: string;
    containerPath?: string;
    openWorkspaceId?: string;
    branch?: string;
    repoRoot?: string;
  });

export function registerStartWorktreeAgentTool(
  pi: ExtensionAPI,
  deps: HerdrToolDeps,
): void {
  pi.registerTool(
    defineTool<typeof startWorktreeAgentParams, StartWorktreeAgentDetails>({
      name: "devcontainer_herdr_start_worktree_agent",
      label: "Create a worktree and start an agent in it, in one call",
      description:
        "The default path for 'start a new feature': create a Git worktree (see " +
        "devcontainer_herdr_worktree_create — pass `branch` or `purpose`) and start an " +
        "agent in it (see devcontainer_herdr_start_agent), reusing the pane the worktree's " +
        "workspace already opened rather than leaving it idle and splitting a second one. " +
        "If create fails, nothing was created and this returns create's own error " +
        "unchanged. If create succeeds but start fails, the worktree is NOT rolled back — " +
        "the result names `hostPath` and `openWorkspaceId` and points at " +
        "devcontainer_herdr_start_agent to retry against the existing worktree.",
      promptSnippet:
        "Create a worktree and start an agent in it in one call — the default for new work",
      promptGuidelines: [
        "Use devcontainer_herdr_start_worktree_agent as the default way to isolate new work " +
          "in a worktree and hand it to an agent — it is the one-call form of " +
          "devcontainer_herdr_worktree_create followed by devcontainer_herdr_start_agent. " +
          "Fall back to the two separate tools only when you need to inspect or adjust the " +
          "worktree before an agent starts in it.",
        "Pass `purpose` (a few words) rather than inventing a branch name; the derived " +
          "`agent/<slug>` name is always reported back in the result — never assume it.",
        "When create succeeds but starting the agent fails, the worktree still exists " +
          "(`hostPath`/`openWorkspaceId` are in the result) — retry with " +
          "devcontainer_herdr_start_agent rather than creating a second worktree.",
        "When the user asks only to provision a worktree/agent, do not also send it a work " +
          "prompt — provisioning and delegating a task are two different requests.",
      ],
      parameters: startWorktreeAgentParams,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const a = await anchor(deps, ctx);
        if (!a.ok) return fail<StartWorktreeAgentDetails & ErrorDetails>(a.code, a.message);

        const created = await createWorktreeCore(params, deps, a.mounts, signal);
        if (!created.ok) {
          return fail<StartWorktreeAgentDetails & ErrorDetails>(created.code, created.message);
        }

        const started = await startAgentCore(
          {
            name: params.name,
            agent: params.agent,
            command: params.command,
            agentArgs: params.agentArgs,
            hostPath: created.details.hostPath,
            workspaceId: created.details.openWorkspaceId,
            env: params.env,
            model: params.model,
            waitForReady: params.waitForReady,
            launcher: params.launcher,
          },
          deps,
          a.info,
          a.mounts,
          signal,
        );
        if (!started.ok) {
          // The worktree stays — a partial failure here must not read as "nothing happened",
          // and must not silently discard a checkout that may already hold work.
          return errorResult(
            `Worktree created at ${created.details.hostPath} (workspace ` +
              `${created.details.openWorkspaceId}), but starting the agent failed: ` +
              `${started.code}: ${started.message} The worktree was NOT removed — retry with ` +
              "devcontainer_herdr_start_agent, passing hostPath and workspaceId " +
              `(openWorkspaceId) from this result.`,
            {
              error: { code: started.code, message: started.message },
              worktreeCreated: true,
              hostPath: created.details.hostPath,
              containerPath: created.details.containerPath,
              openWorkspaceId: created.details.openWorkspaceId,
              branch: created.details.branch,
              repoRoot: created.details.repoRoot,
            } satisfies StartWorktreeAgentDetails & ErrorDetails,
          );
        }

        return okResult(
          `${created.text} ${started.text}`,
          { ...created.details, ...started.details } as StartWorktreeAgentOkDetails,
        );
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// devcontainer_herdr_worktree_list
// ---------------------------------------------------------------------------

const worktreeListParams = Type.Object({
  repo: Type.Optional(
    Type.String({
      description: "HOST path inside the repo to list worktrees for (default: pi's host cwd).",
    }),
  ),
});

type WorktreeListEntry = {
  branch: string | undefined;
  hostPath: string | undefined;
  /** `null` when `containerVisible` is false — never a guessed path. */
  containerPath: string | null;
  openWorkspaceId: string | undefined;
  label: string | undefined;
  /** Whether any bind mount of the routed container covers `hostPath`. A worktree that
   * fails this is one no container agent can be started in. */
  containerVisible: boolean;
};
type WorktreeListOkDetails = { repoRoot: string; worktrees: WorktreeListEntry[] };
type WorktreeListDetails = WorktreeListOkDetails | ErrorDetails;

function pickStr(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * Tolerantly pull the worktree array out of a `worktree list` response: under `worktrees`,
 * or the response itself as an array. Not an exhaustive schema — same posture as this
 * package's other `extract*` helpers — only enough to survive whichever shape comes back;
 * `worktree list`'s success shape has not been observed live, only its argument-conflict
 * error (see the plan's § Step 7 / `devc-dev/docs/herdr-host-orchestrator.md`).
 */
function extractWorktreeList(d: unknown): Array<{
  branch?: string;
  hostPath?: string;
  label?: string;
  openWorkspaceId?: string;
}> {
  const arr = Array.isArray(d)
    ? d
    : d && typeof d === "object" && Array.isArray((d as Record<string, unknown>).worktrees)
    ? (d as Record<string, unknown>).worktrees as unknown[]
    : [];
  return arr.map((w) => {
    if (!w || typeof w !== "object") return {};
    const o = w as Record<string, unknown>;
    return {
      branch: pickStr(o, "branch"),
      // Deliberately `path`, not `hostPath`: Herdr's own response vocabulary is host-only
      // (this tool exists specifically to add the container half — see the plan's
      // "not herdr_worktree_list" concept boundary).
      hostPath: pickStr(o, "path"),
      label: pickStr(o, "label"),
      openWorkspaceId: pickStr(
        o,
        "open_workspace_id",
        "openWorkspaceId",
        "workspace_id",
        "workspaceId",
      ),
    };
  });
}

export function registerWorktreeListTool(
  pi: ExtensionAPI,
  deps: HerdrToolDeps,
): void {
  pi.registerTool(
    defineTool<typeof worktreeListParams, WorktreeListDetails>({
      name: "devcontainer_herdr_worktree_list",
      label: "List worktrees, with container visibility",
      description:
        "List Git worktrees for a repo, in BOTH path vocabularies: each entry's `hostPath` " +
        "(Herdr's own view) and the `containerPath` a container agent would see " +
        "(`null` when `containerVisible` is false — never a guessed path). This is NOT " +
        "pi-herdr's herdr_worktree_list — that tool's `workspaceId`+`cwd` combination is " +
        "rejected by the `herdr` CLI despite its schema accepting both (an upstream bug, " +
        "not this tool's), and it never reports container visibility at all, which is the " +
        "one thing only this side can compute: the same NOT_MOUNTED_IN_CONTAINER condition " +
        "devcontainer_herdr_worktree_path already guards at creation time. A worktree that " +
        "fails it is one no container agent can be started in — cheaper to see in a list " +
        "than to discover at launch.",
      promptSnippet: "List worktrees with both host and container paths",
      promptGuidelines: [
        "Use devcontainer_herdr_worktree_list instead of pi-herdr's herdr_worktree_list when " +
          "you need to know whether a worktree is visible to the container " +
          "(`containerVisible`) — herdr_worktree_list only ever reports host paths.",
        "A `containerVisible: false` entry cannot host a container agent — fix it with a " +
          "mount in .devc/devc.jsonc (via `devc config`) and a rebuild, the same fix as " +
          "NOT_MOUNTED_IN_CONTAINER on the other tools, not a retry.",
      ],
      parameters: worktreeListParams,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const a = await anchor(deps, ctx);
        if (!a.ok) return fail<WorktreeListDetails & ErrorDetails>(a.code, a.message);

        const startPath = params.repo
          ? resolve(deps.hostCwd, expandTilde(params.repo, deps.homedir))
          : deps.hostCwd;
        const repoRoot = deps.gitRevParseTopLevel(startPath);
        if (!repoRoot) {
          return fail<WorktreeListDetails & ErrorDetails>(
            "NOT_A_REPO",
            `No git repository found at or above '${startPath}' on this host. Pass \`repo\` ` +
              "as a host path inside the repo you want worktrees for, or start pi from " +
              "within it.",
          );
        }

        // One repo-selection parameter (`--cwd`), never `--workspace` too — the upstream
        // `workspaceId`+`cwd` conflict this tool exists to route around, designed out rather
        // than worked around.
        const r = await deps.runHerdr<unknown>(
          ["worktree", "list", "--cwd", repoRoot, "--json"],
          { signal },
        );
        if (!r.ok) {
          return fail<WorktreeListDetails & ErrorDetails>("HERDR_FAILED", r.message);
        }

        const worktrees: WorktreeListEntry[] = extractWorktreeList(r.data).map((w) => {
          const containerPath = w.hostPath ? hostToContainerPath(w.hostPath, a.mounts) : null;
          return {
            branch: w.branch,
            hostPath: w.hostPath,
            containerPath,
            openWorkspaceId: w.openWorkspaceId,
            label: w.label,
            containerVisible: containerPath !== null,
          };
        });

        return okResult(
          `${worktrees.length} worktree(s) for ${repoRoot}` +
            (worktrees.some((w) => !w.containerVisible)
              ? " — at least one is NOT visible to the container (containerVisible: false)."
              : "."),
          { repoRoot, worktrees },
        );
      },
    }),
  );
}

/** Register all five. Callers gate this on a resolvable Herdr binary — see `index.ts`. */
export function registerDevcontainerHerdrTools(
  pi: ExtensionAPI,
  deps: HerdrToolDeps,
): void {
  registerWorktreePathTool(pi, deps);
  registerWorktreeCreateTool(pi, deps);
  registerStartAgentTool(pi, deps);
  registerStartWorktreeAgentTool(pi, deps);
  registerWorktreeListTool(pi, deps);
}
