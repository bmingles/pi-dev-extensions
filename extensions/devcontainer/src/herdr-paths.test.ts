import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContainerMount } from "@devc-tools/core";
import { type HerdrPathDeps, resolveHerdrWorktreePath } from "./herdr-paths.ts";

const MOUNTS: ContainerMount[] = [
  {
    type: "bind",
    source: "/Users/me/code/tools/devc-tools",
    destination: "/workspaces/tools/devc-tools",
    rw: true,
  },
  {
    type: "bind",
    source: "/Users/me/code/tools/devc-tools.worktrees",
    destination: "/workspaces/tools/devc-tools.worktrees",
    rw: true,
  },
  // A repo that is mounted but whose `.worktrees` sibling is not.
  {
    type: "bind",
    source: "/Users/me/code/tools/lonely",
    destination: "/workspaces/tools/lonely",
    rw: true,
  },
];

function deps(over: Partial<HerdrPathDeps> = {}): HerdrPathDeps {
  return {
    gitRevParseTopLevel: () => "/Users/me/code/tools/devc-tools",
    pathExists: () => false,
    homedir: "/Users/me",
    ...over,
  };
}

const HOST_CWD = "/Users/me/code/tools/devc-tools";

test("resolves both vocabularies and names the mount it went through", () => {
  const r = resolveHerdrWorktreePath(
    { branch: "feature/foo" },
    HOST_CWD,
    MOUNTS,
    deps(),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.repoRoot, "/Users/me/code/tools/devc-tools");
  assert.equal(r.repoName, "devc-tools");
  assert.equal(r.worktreesDir, "/Users/me/code/tools/devc-tools.worktrees");
  assert.equal(r.hostPath, "/Users/me/code/tools/devc-tools.worktrees/feature-foo");
  assert.equal(
    r.containerPath,
    "/workspaces/tools/devc-tools.worktrees/feature-foo",
  );
  assert.equal(r.slug, "feature-foo");
  assert.equal(r.branch, "feature/foo");
  assert.deepEqual(r.mount, {
    source: "/Users/me/code/tools/devc-tools.worktrees",
    destination: "/workspaces/tools/devc-tools.worktrees",
  });
});

test("NOT_A_REPO when git finds no toplevel", () => {
  const r = resolveHerdrWorktreePath(
    { branch: "x" },
    HOST_CWD,
    MOUNTS,
    deps({ gitRevParseTopLevel: () => undefined }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "NOT_A_REPO");
  assert.match(r.message, /host path inside the repo/);
});

test("`repo` is resolved against the host cwd before git rev-parse", () => {
  const seen: string[] = [];
  resolveHerdrWorktreePath(
    { repo: "../lonely", branch: "x" },
    HOST_CWD,
    MOUNTS,
    deps({
      gitRevParseTopLevel: (cwd) => {
        seen.push(cwd);
        return "/Users/me/code/tools/lonely";
      },
    }),
  );
  assert.deepEqual(seen, ["/Users/me/code/tools/lonely"]);
});

test("NOT_MOUNTED_IN_CONTAINER when no bind mount covers the derived path", () => {
  const r = resolveHerdrWorktreePath(
    { branch: "x" },
    HOST_CWD,
    MOUNTS,
    deps({ gitRevParseTopLevel: () => "/Users/me/code/tools/lonely" }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "NOT_MOUNTED_IN_CONTAINER");
  // The message must name the derived directory and point at the fix.
  assert.match(r.message, /lonely\.worktrees/);
  assert.match(r.message, /devc config/);
  assert.match(r.message, /devc\.jsonc/);
});

test("NOT_MOUNTED_IN_CONTAINER is a different string from the container-side NOT_A_MOUNT", () => {
  // The two predicates ask different questions of different evidence; a reader grepping
  // for one must not find the other.
  const r = resolveHerdrWorktreePath(
    { branch: "x" },
    HOST_CWD,
    [],
    deps(),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "NOT_MOUNTED_IN_CONTAINER");
  assert.ok(!r.message.includes("NOT_A_MOUNT"));
});

test("a volume covering the path does not count as mounted", () => {
  const r = resolveHerdrWorktreePath(
    { branch: "x" },
    HOST_CWD,
    [{
      type: "volume",
      source: "/var/lib/docker/volumes/v/_data",
      destination: "/Users/me/code/tools/devc-tools.worktrees",
      rw: true,
    }],
    deps(),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "NOT_MOUNTED_IN_CONTAINER");
});

test("PATH_EXISTS is checked after the mount guard, not before", () => {
  const r = resolveHerdrWorktreePath(
    { branch: "feat" },
    HOST_CWD,
    MOUNTS,
    deps({ pathExists: () => true }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "PATH_EXISTS");
  assert.match(r.message, /already exists on the host/);

  // With no mount, the mount guard wins even though the path also exists.
  const r2 = resolveHerdrWorktreePath(
    { branch: "feat" },
    HOST_CWD,
    [],
    deps({ pathExists: () => true }),
  );
  assert.equal(r2.ok, false);
  if (r2.ok) return;
  assert.equal(r2.code, "NOT_MOUNTED_IN_CONTAINER");
});

test("PATH_EXISTS is asked about the host path, not the container one", () => {
  const asked: string[] = [];
  resolveHerdrWorktreePath({ branch: "feat" }, HOST_CWD, MOUNTS, deps({
    pathExists: (p) => {
      asked.push(p);
      return false;
    },
  }));
  assert.deepEqual(asked, [
    "/Users/me/code/tools/devc-tools.worktrees/feat",
  ]);
});

test("a nested mount wins, so the container path is the specific one", () => {
  const r = resolveHerdrWorktreePath({ branch: "feat" }, HOST_CWD, [
    { type: "bind", source: "/Users/me/code", destination: "/workspaces", rw: true },
    ...MOUNTS,
  ], deps());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(
    r.containerPath,
    "/workspaces/tools/devc-tools.worktrees/feat",
  );
});

test("a ~ repo resolves instead of being joined onto the cwd", () => {
  const seen: string[] = [];
  const r = resolveHerdrWorktreePath(
    { repo: "~/code/tools/devc-tools", branch: "feat" },
    HOST_CWD,
    MOUNTS,
    deps({
      gitRevParseTopLevel: (cwd) => {
        seen.push(cwd);
        return "/Users/me/code/tools/devc-tools";
      },
    }),
  );
  assert.deepEqual(seen, ["/Users/me/code/tools/devc-tools"]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.containerPath, "/workspaces/tools/devc-tools.worktrees/feat");
});
