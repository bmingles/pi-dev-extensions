import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveWorktreeLayout, slugify } from "./worktree-layout.ts";

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
