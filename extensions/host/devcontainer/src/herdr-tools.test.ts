import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContainerMount, WorktreeInfo } from "@devc-tools/core";
import type { HerdrResult } from "pi-extension-herdr-core";
import {
  type HerdrToolDeps,
  registerDevcontainerHerdrTools,
} from "./herdr-tools.ts";
import type { ContainerInfo } from "./container.ts";

const MOUNTS: ContainerMount[] = [{
  type: "bind",
  source: "/Users/me/code/tools/repo.worktrees",
  destination: "/workspaces/tools/repo.worktrees",
  rw: true,
}, {
  type: "bind",
  source: "/Users/me/code/tools/repo",
  destination: "/workspaces/tools/repo",
  rw: true,
}];

const INFO = {
  containerId: "container123",
  remoteUser: "vscode",
  remoteWorkspaceFolder: "/workspaces/tools/repo",
} as ContainerInfo;

interface Harness {
  tools: Map<string, { execute: Function }>;
  calls: string[][];
  deps: HerdrToolDeps;
}

/** A fake pi + a scripted `herdr`, so the whole flow runs with no Docker, Herdr or pi. */
function harness(
  over: Partial<HerdrToolDeps> & {
    herdr?: (args: string[]) => HerdrResult<unknown>;
  } = {},
): Harness {
  const tools = new Map<string, { execute: Function }>();
  const calls: string[][] = [];
  const { herdr, ...depsOver } = over;

  const deps: HerdrToolDeps = {
    hostCwd: "/Users/me/code/tools/repo",
    ensureContainer: async () => ({ ok: true, info: INFO }),
    getMounts: async () => MOUNTS,
    gitRevParseTopLevel: () => "/Users/me/code/tools/repo",
    pathExists: () => false,
    homedir: "/Users/me",
    runHerdr: async <T>(args: string[]) => {
      calls.push(args);
      const scripted = herdr?.(args) ??
        ({ ok: true, data: {} } as HerdrResult<unknown>);
      return scripted as HerdrResult<T>;
    },
    resolveWorktree: async (): Promise<WorktreeInfo> => ({
      isWorktree: true,
      valid: true,
    }),
    sleep: async () => {},
    now: () => 0,
    ...depsOver,
  };

  const pi = {
    registerTool: (t: { name: string; execute: Function }) =>
      tools.set(t.name, t),
  } as unknown as ExtensionAPI;
  registerDevcontainerHerdrTools(pi, deps);
  return { tools, calls, deps };
}

// deno-lint-ignore no-explicit-any
function run(h: Harness, name: string, params: unknown): Promise<any> {
  const tool = h.tools.get(name);
  assert.ok(tool, `${name} not registered`);
  return tool.execute("id", params, undefined, undefined, undefined);
}

test("all five tools register under the devcontainer_herdr_ prefix", () => {
  const h = harness();
  assert.deepEqual([...h.tools.keys()].sort(), [
    "devcontainer_herdr_start_agent",
    "devcontainer_herdr_start_worktree_agent",
    "devcontainer_herdr_worktree_create",
    "devcontainer_herdr_worktree_list",
    "devcontainer_herdr_worktree_path",
  ]);
  // Never the container-side `herdr_devc_*` names, which are a different topology.
  assert.ok(![...h.tools.keys()].some((n) => n.startsWith("herdr_devc_")));
});

// ---- devcontainer_herdr_worktree_path ---------------------------------------

test("worktree_path returns both vocabularies and calls no herdr", async () => {
  const h = harness();
  const r = await run(h, "devcontainer_herdr_worktree_path", { branch: "feat" });
  assert.equal(r.isError, undefined);
  assert.equal(r.details.hostPath, "/Users/me/code/tools/repo.worktrees/feat");
  assert.equal(
    r.details.containerPath,
    "/workspaces/tools/repo.worktrees/feat",
  );
  assert.equal(r.details.path, undefined, "no bare `path` field");
  assert.deepEqual(h.calls, []);
});

test("worktree_path reports CONTAINER_UNAVAILABLE rather than throwing", async () => {
  const h = harness({
    ensureContainer: async () => ({ ok: false, message: "docker is not running" }),
  });
  const r = await run(h, "devcontainer_herdr_worktree_path", { branch: "feat" });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "CONTAINER_UNAVAILABLE");
  assert.match(r.details.error.message, /docker is not running/);
});

test("worktree_path surfaces a mount-table failure as CONTAINER_UNAVAILABLE", async () => {
  const h = harness({
    getMounts: async () => {
      throw new Error("container mounts unavailable: spawn docker ENOENT");
    },
  });
  const r = await run(h, "devcontainer_herdr_worktree_path", { branch: "feat" });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "CONTAINER_UNAVAILABLE");
});

// ---- devcontainer_herdr_worktree_create -------------------------------------

test("worktree_create creates nothing when the path guard fires", async () => {
  const h = harness({ pathExists: () => true });
  const r = await run(h, "devcontainer_herdr_worktree_create", { branch: "feat" });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "PATH_EXISTS");
  assert.deepEqual(h.calls, [], "herdr must not be called");
});

test("worktree_create passes host paths for both --cwd and --path", async () => {
  const h = harness({
    herdr: () => ({ ok: true, data: { worktree: { branch: "feat" } } }),
  });
  const r = await run(h, "devcontainer_herdr_worktree_create", {
    branch: "feat",
    base: "main",
  });
  assert.equal(r.isError, undefined);
  const args = h.calls[0];
  assert.deepEqual(args.slice(0, 2), ["worktree", "create"]);
  assert.equal(args[args.indexOf("--cwd") + 1], "/Users/me/code/tools/repo");
  assert.equal(
    args[args.indexOf("--path") + 1],
    "/Users/me/code/tools/repo.worktrees/feat",
  );
  assert.equal(args[args.indexOf("--base") + 1], "main");
  assert.ok(args.includes("--no-focus"), "background work must not steal focus");
  assert.ok(args.includes("--json"), "`worktree create` accepts and ignores --json");
});

test("worktree_create returns its own label and path, not Herdr's echo", async () => {
  const h = harness({
    herdr: () => ({
      ok: true,
      data: {
        worktree: {
          // Herdr echoes its own per-repo default label and an unnormalized path.
          label: "repo",
          path: "/Users/me/code/tools/repo/../repo.worktrees/feat",
          branch: "feat",
          open_workspace_id: "ws-1",
        },
      },
    }),
  });
  const r = await run(h, "devcontainer_herdr_worktree_create", { branch: "feat" });
  assert.equal(r.details.label, "repo:feat");
  assert.equal(r.details.hostPath, "/Users/me/code/tools/repo.worktrees/feat");
  assert.equal(r.details.containerPath, "/workspaces/tools/repo.worktrees/feat");
  assert.equal(r.details.openWorkspaceId, "ws-1");
});

test("worktree_create honours an explicit label and focus", async () => {
  const h = harness();
  await run(h, "devcontainer_herdr_worktree_create", {
    branch: "feat",
    label: "mine",
    focus: true,
  });
  const args = h.calls[0];
  assert.equal(args[args.indexOf("--label") + 1], "mine");
  assert.ok(args.includes("--focus"));
});

test("worktree_create fails ABSOLUTE_GITDIR on an unmountable checkout", async () => {
  const h = harness({
    resolveWorktree: async () => ({
      isWorktree: true,
      valid: false,
      reason: "worktree uses absolute paths",
    }),
  });
  const r = await run(h, "devcontainer_herdr_worktree_create", { branch: "feat" });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "ABSOLUTE_GITDIR");
  // The fix is on the host git, and the worktree must be recreated — not retried.
  assert.match(r.details.error.message, /useRelativePaths=true/);
  assert.match(r.details.error.message, /will not help/);
});

test("worktree_create tolerates a non-worktree probe result", async () => {
  const h = harness({ resolveWorktree: async () => ({ isWorktree: false }) });
  const r = await run(h, "devcontainer_herdr_worktree_create", { branch: "feat" });
  assert.equal(r.isError, undefined);
});

test("worktree_create maps a herdr failure to HERDR_FAILED", async () => {
  const h = harness({ herdr: () => ({ ok: false, message: "branch exists" }) });
  const r = await run(h, "devcontainer_herdr_worktree_create", { branch: "feat" });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "HERDR_FAILED");
  assert.match(r.details.error.message, /branch exists/);
});

// ---- devcontainer_herdr_start_agent -----------------------------------------

function startHarness(over: Partial<HerdrToolDeps> = {}) {
  return harness({
    herdr: (args) => {
      if (args[0] === "pane" && args[1] === "split") {
        return { ok: true, data: { pane: { pane_id: "%7" } } };
      }
      return { ok: true, data: {} };
    },
    ...over,
  });
}

test("start_agent splits on the host path and execs on the container path", async () => {
  const h = startHarness();
  const r = await run(h, "devcontainer_herdr_start_agent", {
    hostPath: "/Users/me/code/tools/repo.worktrees/feat",
  });
  assert.equal(r.isError, undefined, JSON.stringify(r.details));

  const split = h.calls.find((c) => c[1] === "split")!;
  assert.equal(
    split[split.indexOf("--cwd") + 1],
    "/Users/me/code/tools/repo.worktrees/feat",
    "the pane's own shell cwd is the HOST path",
  );
  assert.ok(split.includes("--no-focus"));
  assert.ok(!split.includes("--json"), "pane split drops --json");

  const runCall = h.calls.find((c) => c[1] === "run")!;
  assert.ok(!runCall.includes("--json"), "pane run rejects --json on 0.8.2");
  const line = runCall[3];
  assert.ok(line.startsWith("HERDR_AGENT='claude' docker exec -it"), line);
  assert.ok(
    line.includes("-w '/workspaces/tools/repo.worktrees/feat'"),
    "the agent's cwd is the CONTAINER path",
  );
  assert.ok(line.includes("'container123'"));
  assert.ok(line.includes("sh -lc 'exec '\\''claude'\\'''"), line);

  assert.equal(r.details.paneId, "%7");
  assert.equal(r.details.hostPath, "/Users/me/code/tools/repo.worktrees/feat");
  assert.equal(
    r.details.containerPath,
    "/workspaces/tools/repo.worktrees/feat",
  );
  assert.equal(r.details.containerId, "container123");
});

test("start_agent defaults to the 'claude' kind, not pi-herdr's 'pi'", async () => {
  const h = startHarness();
  const r = await run(h, "devcontainer_herdr_start_agent", {});
  assert.equal(r.details.agent, "claude");
});

test("start_agent defaults hostPath to pi's host cwd", async () => {
  const h = startHarness();
  const r = await run(h, "devcontainer_herdr_start_agent", {});
  assert.equal(r.details.hostPath, "/Users/me/code/tools/repo");
  assert.equal(r.details.containerPath, "/workspaces/tools/repo");
});

test("start_agent refuses a host path the container cannot see", async () => {
  const h = startHarness();
  const r = await run(h, "devcontainer_herdr_start_agent", {
    hostPath: "/Users/me/elsewhere",
  });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "NOT_MOUNTED_IN_CONTAINER");
  assert.deepEqual(h.calls, [], "no pane is split when the guard fires");
});

test("start_agent maps the agent kind to its canonical executable", async () => {
  const h = startHarness();
  await run(h, "devcontainer_herdr_start_agent", { agent: "qodercli" });
  const line = h.calls.find((c) => c[1] === "run")![3];
  assert.ok(line.startsWith("HERDR_AGENT='qodercli'"), line);
  assert.ok(line.includes("exec '\\''qoder'\\''"), line);
});

test("start_agent lets `command` override the derived executable", async () => {
  const h = startHarness();
  await run(h, "devcontainer_herdr_start_agent", {
    agent: "claude",
    command: "/opt/bin/claude",
    agentArgs: ["--permission-mode", "acceptEdits"],
  });
  const line = h.calls.find((c) => c[1] === "run")![3];
  assert.ok(line.includes("'\\''/opt/bin/claude'\\''"), line);
  assert.ok(line.includes("'\\''--permission-mode'\\''"), line);
});

test("start_agent fails PANE_GONE when no pane id comes back", async () => {
  const h = harness({ herdr: () => ({ ok: true, data: { ok: true } }) });
  const r = await run(h, "devcontainer_herdr_start_agent", {});
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "PANE_GONE");
});

test("start_agent renames the pane after detection, best-effort", async () => {
  const h = startHarness();
  await run(h, "devcontainer_herdr_start_agent", { name: "worker-1" });
  const order = h.calls.map((c) => `${c[0]} ${c[1]}`);
  assert.deepEqual(order, [
    "pane split",
    "pane run",
    "agent get",
    "agent rename",
  ]);
  const rename = h.calls.at(-1)!;
  assert.deepEqual(rename, ["agent", "rename", "%7", "worker-1"]);

  const get = h.calls.find((c) => c[0] === "agent" && c[1] === "get")!;
  assert.deepEqual(get, ["agent", "get", "%7"]);
});

test("start_agent drops --json from agent get and agent rename", () => {
  // `agent get` and `agent rename` reject --json outright on 0.8.2 (a usage error) — unlike
  // `pane split`/`pane run`, whose JSON response doesn't depend on the flag either way. The
  // `agent get` case is the more consequential of the two: it's polled in a loop that only
  // checks `.ok`, so the flag being wrong there silently turned every successful launch into
  // AGENT_NOT_DETECTED after the full 20s budget, never surfacing the real cause.
  const h = startHarness();
  return run(h, "devcontainer_herdr_start_agent", {}).then(() => {
    for (const c of h.calls) assert.ok(!c.includes("--json"), c.join(" "));
  });
});

test("start_agent succeeds even when the rename fails", async () => {
  const h = harness({
    herdr: (args) => {
      if (args[1] === "split") return { ok: true, data: { pane: { id: "%9" } } };
      if (args[1] === "rename") return { ok: false, message: "no such agent" };
      return { ok: true, data: {} };
    },
  });
  const r = await run(h, "devcontainer_herdr_start_agent", { name: "n" });
  assert.equal(r.isError, undefined);
  assert.equal(r.details.name, "n");
});

test("start_agent polls agent get until it succeeds", async () => {
  let attempts = 0;
  const slept: number[] = [];
  let clock = 0;
  const h = harness({
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    herdr: (args) => {
      if (args[1] === "split") return { ok: true, data: { pane: { id: "%1" } } };
      if (args[0] === "agent" && args[1] === "get") {
        attempts++;
        return attempts < 3
          ? { ok: false, message: "no agent" }
          : { ok: true, data: { agent: "claude" } };
      }
      return { ok: true, data: {} };
    },
  });
  const r = await run(h, "devcontainer_herdr_start_agent", {});
  assert.equal(r.isError, undefined);
  assert.equal(attempts, 3);
  assert.deepEqual(slept, [500, 500]);
});

test("start_agent gives up with AGENT_NOT_DETECTED after the budget", async () => {
  let clock = 0;
  const h = harness({
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    herdr: (args) => {
      if (args[1] === "split") return { ok: true, data: { pane: { id: "%2" } } };
      if (args[0] === "agent" && args[1] === "get") {
        return { ok: false, message: "no agent" };
      }
      return { ok: true, data: {} };
    },
  });
  const r = await run(h, "devcontainer_herdr_start_agent", {});
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "AGENT_NOT_DETECTED");
  // The message must name the pane and point at the one command that explains it.
  assert.match(r.details.error.message, /%2/);
  assert.match(r.details.error.message, /agent explain %2/);
  assert.equal(clock, 20_000);
});

test("start_agent passes extra env as -e on the docker exec", async () => {
  const h = startHarness();
  await run(h, "devcontainer_herdr_start_agent", { env: { FOO: "bar" } });
  const line = h.calls.find((c) => c[1] === "run")![3];
  assert.ok(line.includes("-e 'FOO=bar'"), line);
  // Not on the pane split: the parameter is documented as docker-exec env.
  const split = h.calls.find((c) => c[1] === "split")!;
  assert.ok(!split.includes("--env"));
});

test("start_agent honours the launcher seam", async () => {
  const h = startHarness({
    buildCommandLine: (opts) => `devc-launcher ${opts.containerPath}`,
  });
  await run(h, "devcontainer_herdr_start_agent", {});
  assert.equal(
    h.calls.find((c) => c[1] === "run")![3],
    "devc-launcher /workspaces/tools/repo",
  );
});

// ---- devcontainer_herdr_start_agent — launcher override ---------------------
// § Selection: an explicit `launcher` bypasses `deps.buildCommandLine` (auto-detect)
// entirely, and "devc" must error rather than silently fall back to "docker" when devc
// isn't usable for this call.

test("launcher: 'docker' bypasses buildCommandLine even when devc auto-detect is wired", async () => {
  const h = startHarness({
    buildCommandLine: () => `devc-launcher-should-not-be-used`,
    devcAvailable: true,
  });
  await run(h, "devcontainer_herdr_start_agent", { launcher: "docker" });
  const line = h.calls.find((c) => c[1] === "run")![3];
  assert.ok(line.startsWith("HERDR_AGENT='claude' docker exec"), line);
});

test("launcher: 'devc' builds the devc form for a covered kind, when devc is available", async () => {
  const h = startHarness({ devcAvailable: true });
  await run(h, "devcontainer_herdr_start_agent", { launcher: "devc", agent: "claude" });
  const line = h.calls.find((c) => c[1] === "run")![3];
  assert.equal(line, "devc claude --cwd '/workspaces/tools/repo'");
});

test("launcher: 'devc' errors clearly (not a silent docker fallback) when devc isn't available", async () => {
  const h = startHarness({ devcAvailable: false });
  const r = await run(h, "devcontainer_herdr_start_agent", { launcher: "devc" });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "DEVC_LAUNCHER_UNAVAILABLE");
  assert.match(r.details.error.message, /no `devc` binary resolved/);
  // Never reaches `pane run` — nothing was launched.
  assert.ok(!h.calls.some((c) => c[1] === "run"));
});

test("launcher: 'devc' errors clearly for a kind devc has no subcommand for", async () => {
  const h = startHarness({ devcAvailable: true });
  const r = await run(h, "devcontainer_herdr_start_agent", {
    launcher: "devc",
    agent: "codex",
  });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "DEVC_LAUNCHER_UNAVAILABLE");
  assert.match(r.details.error.message, /codex/);
  assert.ok(!h.calls.some((c) => c[1] === "run"));
});

test("launcher: 'devc' errors clearly rather than dropping requested env", async () => {
  const h = startHarness({ devcAvailable: true });
  const r = await run(h, "devcontainer_herdr_start_agent", {
    launcher: "devc",
    agent: "claude",
    env: { FOO: "bar" },
  });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "DEVC_LAUNCHER_UNAVAILABLE");
  assert.ok(!h.calls.some((c) => c[1] === "run"));
});

test("with no launcher param, auto-detect (deps.buildCommandLine) still drives the pane", async () => {
  const h = startHarness({
    buildCommandLine: (opts) => `devc-launcher ${opts.containerPath}`,
    devcAvailable: true,
  });
  await run(h, "devcontainer_herdr_start_agent", {});
  assert.equal(
    h.calls.find((c) => c[1] === "run")![3],
    "devc-launcher /workspaces/tools/repo",
  );
});

test("start_agent expands a ~ hostPath instead of refusing it", () => {
  // Without expansion this joins onto nothing sensible, misses every mount, and comes back
  // as NOT_MOUNTED_IN_CONTAINER — the same shape of failure a `~` repo produced on a real
  // host run. There is no shell in the loop to expand it.
  const h = startHarness();
  return run(h, "devcontainer_herdr_start_agent", {
    hostPath: "~/code/tools/repo.worktrees/feat",
  }).then((r) => {
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    assert.equal(r.details.hostPath, "/Users/me/code/tools/repo.worktrees/feat");
    assert.equal(
      r.details.containerPath,
      "/workspaces/tools/repo.worktrees/feat",
    );
  });
});

// ---- devcontainer_herdr_start_agent — workspaceId retarget ------------------
// The first-class create-then-attach path: land the agent in the pane
// devcontainer_herdr_worktree_create already opened, instead of splitting a second one off
// pi's own pane and leaving the first idle.

test("start_agent with workspaceId lists the workspace's panes instead of splitting", async () => {
  const h = harness({
    herdr: (args) => {
      if (args[0] === "pane" && args[1] === "list") {
        assert.deepEqual(args, ["pane", "list", "--workspace", "ws-1"]);
        return { ok: true, data: { panes: [{ pane_id: "%9" }] } };
      }
      return { ok: true, data: {} };
    },
  });
  const r = await run(h, "devcontainer_herdr_start_agent", {
    hostPath: "/Users/me/code/tools/repo.worktrees/feat",
    workspaceId: "ws-1",
  });
  assert.equal(r.isError, undefined, JSON.stringify(r.details));
  assert.equal(r.details.paneId, "%9");
  assert.equal(r.details.reusedWorkspaceId, "ws-1");
  assert.ok(!h.calls.some((c) => c[1] === "split"), "no pane is split");

  const run_ = h.calls.find((c) => c[1] === "run")!;
  assert.equal(run_[2], "%9", "runs in the workspace's own pane");
});

test("start_agent ignores split/focus when workspaceId is passed", async () => {
  const h = harness({
    herdr: (args) => {
      if (args[0] === "pane" && args[1] === "list") {
        return { ok: true, data: { panes: [{ id: "%1" }] } };
      }
      return { ok: true, data: {} };
    },
  });
  await run(h, "devcontainer_herdr_start_agent", {
    workspaceId: "ws-1",
    split: "down",
    focus: true,
  });
  assert.ok(!h.calls.some((c) => c[1] === "split"));
});

test("start_agent fails PANE_GONE when the workspace has no pane", async () => {
  const h = harness({
    herdr: (args) => {
      if (args[0] === "pane" && args[1] === "list") {
        return { ok: true, data: { panes: [] } };
      }
      return { ok: true, data: {} };
    },
  });
  const r = await run(h, "devcontainer_herdr_start_agent", { workspaceId: "ws-1" });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "PANE_GONE");
  assert.match(r.details.error.message, /ws-1/);
});

test("start_agent maps a pane-list failure to HERDR_FAILED when workspaceId is passed", async () => {
  const h = harness({
    herdr: (args) => {
      if (args[0] === "pane" && args[1] === "list") {
        return { ok: false, message: "no such workspace" };
      }
      return { ok: true, data: {} };
    },
  });
  const r = await run(h, "devcontainer_herdr_start_agent", { workspaceId: "ws-1" });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "HERDR_FAILED");
  assert.match(r.details.error.message, /no such workspace/);
});

// ---- devcontainer_herdr_start_agent — structured model ----------------------

test("start_agent appends the model flag for a covered kind", async () => {
  const h = startHarness();
  await run(h, "devcontainer_herdr_start_agent", { agent: "claude", model: "opus" });
  const line = h.calls.find((c) => c[1] === "run")![3];
  assert.ok(line.includes("'\\''--model'\\'' '\\''opus'\\'''"), line);
});

test("start_agent reports startupState: 'detected' on a normal success", async () => {
  const h = startHarness();
  const r = await run(h, "devcontainer_herdr_start_agent", {});
  assert.equal(r.details.startupState, "detected");
});

test("start_agent fails MODEL_UNSUPPORTED for a kind with no known model flag, before ever calling herdr", async () => {
  const h = startHarness();
  const r = await run(h, "devcontainer_herdr_start_agent", { agent: "codex", model: "big" });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "MODEL_UNSUPPORTED");
  assert.match(r.details.error.message, /codex/);
  assert.deepEqual(h.calls, [], "no pane is split, nothing is launched");
});

test("start_agent drops `model` when agentArgs already spells out --model, and says so", async () => {
  const h = startHarness();
  const r = await run(h, "devcontainer_herdr_start_agent", {
    agent: "claude",
    model: "opus",
    agentArgs: ["--model", "sonnet"],
  });
  assert.equal(r.isError, undefined);
  const line = h.calls.find((c) => c[1] === "run")![3];
  // Exactly one --model, the one from agentArgs, and it isn't followed by a second one.
  const modelCount = (line.match(/--model/g) ?? []).length;
  assert.equal(modelCount, 1, line);
  assert.ok(line.includes("'\\''--model'\\'' '\\''sonnet'\\'''"), line);
  assert.match(r.content[0].text, /ignored because agentArgs already spells out --model/);
});

test("start_agent waitForReady resolves to 'unknown' — no kind has a measured ready pattern yet", async () => {
  const h = startHarness();
  const r = await run(h, "devcontainer_herdr_start_agent", { waitForReady: true });
  assert.equal(r.isError, undefined);
  assert.equal(r.details.startupState, "unknown");
});

// ---- devcontainer_herdr_worktree_create — branch/purpose derivation ---------

test("worktree_create requires branch or purpose", async () => {
  const h = harness();
  const r = await run(h, "devcontainer_herdr_worktree_create", {});
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "BRANCH_OR_PURPOSE_REQUIRED");
  assert.deepEqual(h.calls, [], "herdr must not be called");
});

test("worktree_create derives agent/<slug> from purpose when branch is omitted", async () => {
  const h = harness({
    herdr: () => ({ ok: true, data: { worktree: {} } }),
  });
  const r = await run(h, "devcontainer_herdr_worktree_create", {
    purpose: "Fix the flaky retry test!",
  });
  assert.equal(r.isError, undefined, JSON.stringify(r.details));
  assert.equal(r.details.branch, "agent/fix-the-flaky-retry-test");
  const args = h.calls[0];
  assert.equal(args[args.indexOf("--branch") + 1], "agent/fix-the-flaky-retry-test");
});

test("worktree_create disambiguates a derived-name collision with a numeric suffix", async () => {
  const h = harness({
    // The first two candidate paths already exist on the host; the third is free.
    pathExists: (p) =>
      p.endsWith("agent-fix-flaky-test") || p.endsWith("agent-fix-flaky-test-2"),
    herdr: () => ({ ok: true, data: { worktree: {} } }),
  });
  const r = await run(h, "devcontainer_herdr_worktree_create", { purpose: "fix flaky test" });
  assert.equal(r.isError, undefined, JSON.stringify(r.details));
  assert.equal(r.details.branch, "agent/fix-flaky-test-3");
});

test("worktree_create fails DERIVED_BRANCH_EXHAUSTED when every suffix collides, without calling herdr", async () => {
  const h = harness({ pathExists: () => true });
  const r = await run(h, "devcontainer_herdr_worktree_create", { purpose: "busy purpose" });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "DERIVED_BRANCH_EXHAUSTED");
  assert.deepEqual(h.calls, []);
});

test("worktree_create still fails PATH_EXISTS (not DERIVED_BRANCH_EXHAUSTED) for an explicit branch collision", async () => {
  // An explicit `branch` never gets the retry-with-suffix treatment — a collision on it is
  // always an error, exactly as it was before `purpose` existed.
  const h = harness({ pathExists: () => true });
  const r = await run(h, "devcontainer_herdr_worktree_create", { branch: "feat" });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "PATH_EXISTS");
});

// ---- devcontainer_herdr_start_worktree_agent --------------------------------

function worktreeAgentHarness(
  over: Partial<HerdrToolDeps> & { herdr?: (args: string[]) => HerdrResult<unknown> } = {},
) {
  return harness({
    herdr: (args) => {
      if (args[0] === "worktree" && args[1] === "create") {
        return {
          ok: true,
          data: { worktree: { branch: "agent/feat", open_workspace_id: "ws-1" } },
        };
      }
      if (args[0] === "pane" && args[1] === "list") {
        return { ok: true, data: { panes: [{ pane_id: "%9" }] } };
      }
      return { ok: true, data: {} };
    },
    ...over,
  });
}

test("start_worktree_agent creates a worktree and starts an agent in it, in one call", async () => {
  const h = worktreeAgentHarness();
  const r = await run(h, "devcontainer_herdr_start_worktree_agent", { purpose: "new feature" });
  assert.equal(r.isError, undefined, JSON.stringify(r.details));
  assert.equal(r.details.branch, "agent/feat");
  assert.equal(r.details.openWorkspaceId, "ws-1");
  assert.equal(r.details.paneId, "%9");
  assert.equal(r.details.startupState, "detected");

  const order = h.calls.map((c) => `${c[0]} ${c[1]}`);
  assert.deepEqual(order, [
    "worktree create",
    "pane list", // retargets into the workspace `worktree create` opened — no `pane split`
    "pane run",
    "agent get",
    "agent rename",
  ]);
});

test("start_worktree_agent returns create's own error unchanged when create fails, and never starts anything", async () => {
  const h = harness({ pathExists: () => true });
  const r = await run(h, "devcontainer_herdr_start_worktree_agent", { branch: "feat" });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "PATH_EXISTS");
  assert.deepEqual(h.calls, [], "nothing was created, nothing was launched");
});

test("start_worktree_agent leaves the worktree in place when the start half fails", async () => {
  const h = worktreeAgentHarness({
    herdr: (args) => {
      if (args[0] === "worktree" && args[1] === "create") {
        return {
          ok: true,
          data: { worktree: { branch: "agent/feat", open_workspace_id: "ws-1" } },
        };
      }
      if (args[0] === "pane" && args[1] === "list") {
        return { ok: true, data: { panes: [] } }; // PANE_GONE
      }
      return { ok: true, data: {} };
    },
  });
  const r = await run(h, "devcontainer_herdr_start_worktree_agent", { purpose: "new feature" });
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "PANE_GONE");
  assert.equal(r.details.worktreeCreated, true);
  assert.equal(r.details.openWorkspaceId, "ws-1");
  assert.ok(r.details.hostPath, "hostPath is named so the caller can retry against it");
  assert.match(r.content[0].text, /NOT removed/);
  assert.match(r.content[0].text, /devcontainer_herdr_start_agent/);
});

// ---- devcontainer_herdr_worktree_list ---------------------------------------

test("worktree_list reports containerVisible true and false, and never guesses a containerPath", async () => {
  const h = harness({
    herdr: (args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          ok: true,
          data: {
            worktrees: [
              { path: "/Users/me/code/tools/repo.worktrees/feat", branch: "feat" },
              { path: "/Users/me/elsewhere", branch: "orphan" },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });
  const r = await run(h, "devcontainer_herdr_worktree_list", {});
  assert.equal(r.isError, undefined, JSON.stringify(r.details));
  assert.equal(r.details.worktrees.length, 2);

  const visible = r.details.worktrees.find((w: { branch: string }) => w.branch === "feat");
  assert.equal(visible.containerVisible, true);
  assert.equal(visible.containerPath, "/workspaces/tools/repo.worktrees/feat");

  const hidden = r.details.worktrees.find((w: { branch: string }) => w.branch === "orphan");
  assert.equal(hidden.containerVisible, false);
  assert.equal(hidden.containerPath, null);
});

test("worktree_list passes --cwd, never --workspace, routing around the upstream conflict", async () => {
  const h = harness({
    herdr: (args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        assert.deepEqual(args, [
          "worktree",
          "list",
          "--cwd",
          "/Users/me/code/tools/repo",
          "--json",
        ]);
        return { ok: true, data: { worktrees: [] } };
      }
      return { ok: true, data: {} };
    },
  });
  const r = await run(h, "devcontainer_herdr_worktree_list", {});
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.details.worktrees, []);
});

test("worktree_list fails NOT_A_REPO rather than calling herdr with a bad --cwd", async () => {
  const h = harness({ gitRevParseTopLevel: () => undefined });
  const r = await run(h, "devcontainer_herdr_worktree_list", {});
  assert.equal(r.isError, true);
  assert.equal(r.details.error.code, "NOT_A_REPO");
  assert.deepEqual(h.calls, []);
});
