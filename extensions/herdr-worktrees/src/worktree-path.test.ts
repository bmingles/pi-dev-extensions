import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveWorktreeLayout,
  isMounted,
  type ResolveDeps,
  resolveWorktreePath,
  slugify,
} from "./worktree-path.ts";

// ---- slugify ---------------------------------------------------------------

test("slugify: lowercases", () => {
  assert.equal(slugify("Feature"), "feature");
});

test("slugify: replaces slashes with dashes", () => {
  assert.equal(slugify("feature/foo_bar"), "feature-foo_bar");
});

test("slugify: replaces disallowed characters", () => {
  assert.equal(slugify("fix#123 (urgent)!"), "fix-123-urgent");
});

test("slugify: collapses runs of dashes", () => {
  assert.equal(slugify("a///b"), "a-b");
});

test("slugify: trims leading/trailing dashes", () => {
  assert.equal(slugify("/feature/"), "feature");
});

test("slugify: preserves dots and underscores", () => {
  assert.equal(slugify("release-1.2.3_rc1"), "release-1.2.3_rc1");
});

// ---- deriveWorktreeLayout ---------------------------------------------------

test("deriveWorktreeLayout: sibling .worktrees convention", () => {
  const layout = deriveWorktreeLayout("/workspaces/tools/myrepo", "feat-a");
  assert.equal(layout.repoName, "myrepo");
  assert.equal(layout.worktreesDir, "/workspaces/tools/myrepo.worktrees");
  assert.equal(layout.path, "/workspaces/tools/myrepo.worktrees/feat-a");
  assert.equal(layout.slug, "feat-a");
});

test("deriveWorktreeLayout: normalizes (no .. segments)", () => {
  const layout = deriveWorktreeLayout("/workspaces/tools/myrepo", "feature/foo");
  assert.ok(!layout.path.includes(".."));
  assert.ok(!layout.worktreesDir.includes(".."));
  assert.equal(layout.path, "/workspaces/tools/myrepo.worktrees/feature-foo");
});

test("deriveWorktreeLayout: slugifies the branch component only", () => {
  const layout = deriveWorktreeLayout("/a/b/repo", "Feature/Foo_Bar");
  assert.equal(layout.slug, "feature-foo_bar");
  assert.equal(layout.path, "/a/b/repo.worktrees/feature-foo_bar");
});

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
