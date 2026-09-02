import assert from "node:assert/strict";
import { test } from "node:test";
import { isMounted, type ResolveDeps, resolveWorktreePath } from "./worktree-path.ts";

// ---- isMounted --------------------------------------------------------------

const FIXTURE_MOUNTS = [
  "/run/host_mark/Users /workspaces/tools/devc-tools fakeowner rw,relatime 0 0",
  "/run/host_mark/Users /workspaces/tools/devc-tools.worktrees fakeowner rw,relatime 0 0",
  "/dev/vda1 /workspaces/devc-dev/node_modules ext4 rw,relatime 0 0",
].join("\n");

test("isMounted: true for an exact mountpoint match", () => {
  assert.equal(
    isMounted("/workspaces/tools/devc-tools.worktrees", FIXTURE_MOUNTS),
    true,
  );
});

test("isMounted: false for a directory that merely exists under a mount", () => {
  // /workspaces/devc-dev itself is not a mountpoint in this fixture, even
  // though other things are mounted under /workspaces.
  assert.equal(isMounted("/workspaces/devc-dev.worktrees", FIXTURE_MOUNTS), false);
});

test("isMounted: false for an ancestor of a mounted path", () => {
  assert.equal(isMounted("/workspaces/tools", FIXTURE_MOUNTS), false);
});

test("isMounted: handles octal-escaped mountpoints", () => {
  const withSpace = "/dev/sda1 /mnt/with\\040space ext4 rw 0 0";
  assert.equal(isMounted("/mnt/with space", withSpace), true);
});

// ---- resolveWorktreePath: fixture-driven deps -------------------------------

function fakeDeps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    gitRevParseTopLevel: () => "/workspaces/tools/myrepo",
    readMounts: () => FIXTURE_MOUNTS,
    isContainer: () => true,
    pathExists: () => false,
    homedir: "/home/vscode",
    ...overrides,
  };
}

test("resolveWorktreePath: NOT_A_REPO when git can't find a repo root", () => {
  const result = resolveWorktreePath(
    { branch: "feat-a" },
    "/tmp/not-a-repo",
    fakeDeps({ gitRevParseTopLevel: () => undefined }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "NOT_A_REPO");
});

test("resolveWorktreePath: NOT_A_MOUNT when the .worktrees sibling isn't a bind mount (in a container)", () => {
  const result = resolveWorktreePath(
    { branch: "feat-a" },
    "/workspaces/devc-dev",
    fakeDeps({
      gitRevParseTopLevel: () => "/workspaces/devc-dev",
      readMounts: () => FIXTURE_MOUNTS, // no devc-dev.worktrees entry
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "NOT_A_MOUNT");
    assert.match(result.message, /devc-dev\.worktrees/);
    assert.match(result.message, /devc\.jsonc/);
  }
});

test("resolveWorktreePath: mount check is skipped outside a container", () => {
  const result = resolveWorktreePath(
    { branch: "feat-a" },
    "/workspaces/devc-dev",
    fakeDeps({
      gitRevParseTopLevel: () => "/workspaces/devc-dev",
      isContainer: () => false,
      readMounts: () => FIXTURE_MOUNTS,
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.mounted, true);
});

test("resolveWorktreePath: PATH_EXISTS when the target directory already exists", () => {
  const result = resolveWorktreePath(
    { branch: "feat-a" },
    "/workspaces/tools/devc-tools",
    fakeDeps({
      gitRevParseTopLevel: () => "/workspaces/tools/devc-tools",
      pathExists: () => true,
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "PATH_EXISTS");
});

test("resolveWorktreePath: ok when repo resolves, the sibling is mounted, and the path is free", () => {
  const result = resolveWorktreePath(
    { branch: "feat-a" },
    "/workspaces/tools/devc-tools",
    fakeDeps({ gitRevParseTopLevel: () => "/workspaces/tools/devc-tools" }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.repoRoot, "/workspaces/tools/devc-tools");
    assert.equal(result.repoName, "devc-tools");
    assert.equal(result.worktreesDir, "/workspaces/tools/devc-tools.worktrees");
    assert.equal(result.path, "/workspaces/tools/devc-tools.worktrees/feat-a");
    assert.equal(result.branch, "feat-a");
    assert.equal(result.slug, "feat-a");
    assert.equal(result.mounted, true);
  }
});

test("resolveWorktreePath: repo param is resolved relative to cwd before git rev-parse", () => {
  let seenCwd: string | undefined;
  const result = resolveWorktreePath(
    { repo: "subdir", branch: "feat-a" },
    "/workspaces/tools/devc-tools",
    fakeDeps({
      gitRevParseTopLevel: (cwd) => {
        seenCwd = cwd;
        return "/workspaces/tools/devc-tools";
      },
    }),
  );
  assert.equal(seenCwd, "/workspaces/tools/devc-tools/subdir");
  assert.equal(result.ok, true);
});

test("resolveWorktreePath: a ~ repo is expanded, not joined onto the cwd", () => {
  // Same defect the host-side tools had: this is a tool parameter filled in by a model,
  // and no shell is in the loop to expand the tilde. Without expansion this asks git about
  // '/workspaces/tools/myrepo/~/project' and fails as NOT_A_REPO.
  let seenCwd = "";
  resolveWorktreePath(
    { repo: "~/project", branch: "feat-a" },
    "/workspaces/tools/myrepo",
    fakeDeps({
      gitRevParseTopLevel: (cwd) => {
        seenCwd = cwd;
        return "/home/vscode/project";
      },
    }),
  );
  assert.equal(seenCwd, "/home/vscode/project");
});
