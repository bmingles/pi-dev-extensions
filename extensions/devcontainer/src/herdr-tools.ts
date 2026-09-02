/**
 * Three host-side tools that let a pi orchestrator running on the HOST, alongside a HOST
 * Herdr, fan agents out INTO the devcontainer this extension already routes into
 * (topology 1b — see `devc-dev/docs/herdr-host-orchestrator.md`).
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

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createWorktreeArgs,
  errorResult,
  expandTilde,
  extractWorktree,
  type HerdrResult,
  okResult,
  type RunHerdrOpts,
  type ToolResultWithError,
} from "pi-extension-herdr-core";
import type { ContainerMount, WorktreeInfo } from "@devc-tools/core";
import { hostToContainerPath } from "@devc-tools/core";
import type { ContainerInfo } from "./container.ts";
import {
  type AgentCommandLineOpts,
  buildAgentCommandLine,
  commandForAgentKind,
  extractPaneId,
  paneSplitArgs,
} from "./herdr-launch.ts";
import {
  type HerdrPathDeps,
  type HerdrPathErrorCode,
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
  | "AGENT_NOT_DETECTED";

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
 * The `pane run` command line builder, as a seam. Only the `docker` form is implemented
 * here, and it is the one the extension's stated requirements allow: Docker and Node, no
 * `devc` on PATH.
 *
 * The `devc` variant — `devc attach --cwd <containerPath>` behind the same `HERDR_AGENT`
 * prefix — buys `TERM`/`TERM_PROGRAM`/`TMUX` propagation, the attach tint, and identity
 * rotation if a human takes the pane over. It needs `devc` on PATH (a requirement this
 * extension deliberately does not have) plus `devc`'s `--cwd` flag, so it is left as a
 * substitution rather than stubbed as a parameter with one legal value.
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

type CreateOkDetails = {
  hostPath: string;
  containerPath: string;
  branch: string;
  label: string;
  openWorkspaceId: string | undefined;
  repoRoot: string;
};
type CreateDetails = CreateOkDetails | ErrorDetails;

export function registerWorktreeCreateTool(
  pi: ExtensionAPI,
  deps: HerdrToolDeps,
): void {
  pi.registerTool(
    defineTool<typeof createParams, CreateDetails>({
      name: "devcontainer_herdr_worktree_create",
      label: "Create container-visible worktree",
      description:
        "Create a Git worktree for `branch` on the HOST under the `<repo>.worktrees/<slug>` " +
        "sibling convention and open it as a Herdr workspace. Derives and guards the path " +
        "exactly like devcontainer_herdr_worktree_path (same NOT_A_REPO / " +
        "NOT_MOUNTED_IN_CONTAINER / PATH_EXISTS errors — nothing is created when a guard " +
        "fires) and additionally verifies the new checkout's .git link is RELATIVE, since " +
        "an absolute one names a host path that does not resolve inside the container. " +
        "Defaults to --no-focus. Launch an agent into the returned `hostPath` next with " +
        "devcontainer_herdr_start_agent.",
      promptSnippet:
        "Create a Git worktree the devcontainer can see, and open it as a Herdr workspace",
      promptGuidelines: [
        "Use devcontainer_herdr_worktree_create instead of pi-herdr's herdr_worktree_create " +
          "when the agent that will work in the checkout runs inside the devcontainer — it " +
          "derives --path and guards against a target the container cannot see.",
        "ABSOLUTE_GITDIR is not retryable: remove the created worktree, set " +
          "worktree.useRelativePaths=true on the HOST git (git >= 2.48), and create it again.",
      ],
      parameters: createParams,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const a = await anchor(deps, ctx);
        if (!a.ok) return fail<CreateDetails & ErrorDetails>(a.code, a.message);

        const resolved = resolveHerdrWorktreePath(
          { repo: params.repo, branch: params.branch },
          deps.hostCwd,
          a.mounts,
          deps,
        );
        if (!resolved.ok) {
          return fail<CreateDetails & ErrorDetails>(
            resolved.code,
            resolved.message,
          );
        }

        const label = params.label ?? `${resolved.repoName}:${params.branch}`;
        // Herdr runs on the host in this topology, so `--cwd` and `--path` are both host
        // paths. `--path` is always explicit: Herdr's `worktrees.directory` composes
        // `<root>/<repo>/<branch-slug>` under one global root and cannot express a sibling
        // layout, so the default would be wrong outright, not merely suboptimal.
        const r = await deps.runHerdr<unknown>(
          createWorktreeArgs({
            repoRoot: resolved.repoRoot,
            branch: params.branch,
            path: resolved.hostPath,
            base: params.base,
            label,
            focus: params.focus ?? false,
          }),
          { timeoutMs: 60_000, signal },
        );
        if (!r.ok) {
          return fail<CreateDetails & ErrorDetails>("HERDR_FAILED", r.message);
        }

        // The invariant the whole topology rests on, asserted at the one point that can see
        // it. `devc-core`'s own check runs in the `devc config` mount picker, over worktrees
        // that already exist — it never sees one created dynamically like this.
        const wt = await deps.resolveWorktree(resolved.hostPath);
        if (wt.isWorktree && !wt.valid) {
          return fail<CreateDetails & ErrorDetails>(
            "ABSOLUTE_GITDIR",
            `The worktree at ${resolved.hostPath} has an absolute 'gitdir:' link, which ` +
              "names a host path that does not exist inside the container — the agent " +
              "could not use the checkout. Set `worktree.useRelativePaths=true` on the " +
              "HOST git (git >= 2.48), then remove this worktree " +
              "(`git worktree remove --force`) and create it again. Retrying this tool " +
              "will not help.",
          );
        }

        const w = extractWorktree(r.data);
        // Deliberately not `w.path`: a create response echoes `--path` back unnormalized
        // while `worktree list` normalizes it, so the two are not comparable and only the
        // path we derived is known-normalized.
        const branch = w.branch ?? params.branch;
        // Deliberately not `w.label`: verified live that Herdr's `worktree.label` is its own
        // per-repo default (== repoName), unrelated to the `--label` just passed.
        return okResult(
          `Created worktree on '${branch}' at ${resolved.hostPath} (host), visible to the ` +
            `container at ${resolved.containerPath}` +
            (w.openWorkspaceId ? ` (workspace ${w.openWorkspaceId}).` : "."),
          {
            hostPath: resolved.hostPath,
            containerPath: resolved.containerPath,
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
        "HOST directory for the pane AND (translated) the agent's cwd (default: pi's host " +
        "cwd). Pass what devcontainer_herdr_worktree_create returned.",
    }),
  ),
  split: Type.Optional(
    Type.Union([Type.Literal("right"), Type.Literal("down")], {
      description: "Split direction for the new pane (default: 'right').",
    }),
  ),
  focus: Type.Optional(
    Type.Boolean({ description: "Focus the new pane (default false — background work)." }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Extra environment variables, passed as `-e K=V` on the docker exec.",
    }),
  ),
});

type StartOkDetails = {
  paneId: string;
  name: string;
  agent: string;
  hostPath: string;
  containerPath: string;
  containerId: string;
};
type StartDetails = StartOkDetails | ErrorDetails;

export function registerStartAgentTool(
  pi: ExtensionAPI,
  deps: HerdrToolDeps,
): void {
  const buildCommandLine = deps.buildCommandLine ?? buildAgentCommandLine;

  pi.registerTool(
    defineTool<typeof startParams, StartDetails>({
      name: "devcontainer_herdr_start_agent",
      label: "Start a container agent in a Herdr pane",
      description:
        "Split a new Herdr pane on the HOST and launch an agent INSIDE the routed " +
        "devcontainer in it, with its cwd set to the container path for `hostPath`. " +
        "Identity is asserted with HERDR_AGENT rather than detected, so Herdr's " +
        "working/blocked states remain trustworthy but 'idle' is a fallback that also " +
        "covers 'not started yet' and 'stuck on an auth prompt'. Returns a paneId — drive " +
        "it afterwards with pi-herdr's herdr_send_prompt / herdr_wait_agent / " +
        "herdr_read_agent.",
      promptSnippet:
        "Launch an agent inside the devcontainer in a new Herdr pane",
      promptGuidelines: [
        "Pass the hostPath returned by devcontainer_herdr_worktree_create; the container " +
          "cwd is derived from it, so there is no host/container pair to keep in sync.",
        "After a successful start, drive the pane with pi-herdr's herdr_send_prompt, " +
          "herdr_wait_agent and herdr_read_agent using the returned paneId.",
        "Trust `working` and `blocked`; treat `idle` as unknown. If the agent never " +
          "appears, `herdr agent explain <paneId>` says which detection rule matched.",
      ],
      parameters: startParams,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const a = await anchor(deps, ctx);
        if (!a.ok) return fail<StartDetails & ErrorDetails>(a.code, a.message);

        // Same reason as `repo` in herdr-paths.ts: a model writes `~/...` and no shell
        // is in the loop to expand it.
        const hostPath = params.hostPath
          ? expandTilde(params.hostPath, deps.homedir)
          : deps.hostCwd;
        const containerPath = hostToContainerPath(hostPath, a.mounts);
        if (containerPath === null) {
          return fail<StartDetails & ErrorDetails>(
            "NOT_MOUNTED_IN_CONTAINER",
            `'${hostPath}' is not covered by any bind mount of this container, so an ` +
              "agent inside it has no path for that directory and cannot start there. " +
              "Add a mount for it in `.devc/devc.jsonc` (via `devc config`) and rebuild.",
          );
        }

        const agent = params.agent ?? "claude";
        const name = params.name ?? `agent-${Date.now()}`;

        // `--cwd` on the split is the HOST path: it sets the pane's own shell cwd, which is
        // what Herdr's Space and branch display key off. The container path goes to the
        // `docker exec` below instead.
        const split = await deps.runHerdr<unknown>(
          paneSplitArgs({
            direction: params.split ?? "right",
            hostPath,
            focus: params.focus ?? false,
          }),
          { signal },
        );
        if (!split.ok) {
          return fail<StartDetails & ErrorDetails>("HERDR_FAILED", split.message);
        }
        const paneId = extractPaneId(split.data);
        if (!paneId) {
          return fail<StartDetails & ErrorDetails>(
            "PANE_GONE",
            "herdr pane split reported success but returned no pane id.",
          );
        }

        const commandLine = buildCommandLine({
          agent,
          containerId: a.info.containerId,
          remoteUser: a.info.remoteUser,
          containerPath,
          command: params.command ?? commandForAgentKind(agent),
          agentArgs: params.agentArgs,
          env: params.env,
        });
        const run = await deps.runHerdr<unknown>(
          ["pane", "run", paneId, commandLine, "--json"],
          { signal },
        );
        if (!run.ok) {
          return fail<StartDetails & ErrorDetails>("HERDR_FAILED", run.message);
        }

        // Herdr needs a moment to notice the agent in the pane. This is the same wait
        // pi-herdr's `waitForAgentDetected` does, and the step most likely to behave
        // differently for an *asserted* (rather than detected) container agent.
        const deadline = deps.now() + AGENT_DETECT_BUDGET_MS;
        let detected = false;
        for (;;) {
          const got = await deps.runHerdr<unknown>(
            ["agent", "get", paneId, "--json"],
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
          return fail<StartDetails & ErrorDetails>(
            "AGENT_NOT_DETECTED",
            `Herdr did not report an agent in pane ${paneId} within ` +
              `${AGENT_DETECT_BUDGET_MS / 1000}s. The pane exists and the command was sent, ` +
              `so run \`herdr agent explain ${paneId}\` to see which detection rule (if any) ` +
              "matched, and check the pane for an auth prompt or a failed launch.",
          );
        }

        // Best-effort, exactly as pi-herdr's Windows path treats it: a pane that works under
        // a generated name is better than a failed tool call.
        await deps.runHerdr<unknown>(
          ["agent", "rename", paneId, name, "--json"],
          { signal },
        );

        return okResult(
          `Started '${agent}' in pane ${paneId}, running in the container at ` +
            `${containerPath} (host ${hostPath}). Drive it with pi-herdr's ` +
            `herdr_send_prompt / herdr_wait_agent / herdr_read_agent using paneId ` +
            `'${paneId}'. Trust 'working' and 'blocked'; 'idle' is a fallback that also ` +
            "covers 'not started yet'.",
          {
            paneId,
            name,
            agent,
            hostPath,
            containerPath,
            containerId: a.info.containerId,
          },
        );
      },
    }),
  );
}

/** Register all three. Callers gate this on a resolvable Herdr binary — see `index.ts`. */
export function registerDevcontainerHerdrTools(
  pi: ExtensionAPI,
  deps: HerdrToolDeps,
): void {
  registerWorktreePathTool(pi, deps);
  registerWorktreeCreateTool(pi, deps);
  registerStartAgentTool(pi, deps);
}
