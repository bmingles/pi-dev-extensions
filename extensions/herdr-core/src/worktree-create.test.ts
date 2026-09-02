import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorktreeArgs, extractWorktree } from "./worktree-create.ts";

// ---- createWorktreeArgs -----------------------------------------------------

test("createWorktreeArgs: minimal required fields, defaults to --no-focus", () => {
  const args = createWorktreeArgs({
    repoRoot: "/workspaces/tools/myrepo",
    branch: "feat-a",
    path: "/workspaces/tools/myrepo.worktrees/feat-a",
  });
  assert.deepEqual(args, [
    "worktree",
    "create",
    "--cwd",
    "/workspaces/tools/myrepo",
    "--branch",
    "feat-a",
    "--path",
    "/workspaces/tools/myrepo.worktrees/feat-a",
    "--no-focus",
    "--json",
  ]);
});

test("createWorktreeArgs: includes --base and --label when given", () => {
  const args = createWorktreeArgs({
    repoRoot: "/r",
    branch: "b",
    path: "/r.worktrees/b",
    base: "main",
    label: "myrepo:b",
  });
  assert.deepEqual(args, [
    "worktree",
    "create",
    "--cwd",
    "/r",
    "--branch",
    "b",
    "--path",
    "/r.worktrees/b",
    "--base",
    "main",
    "--label",
    "myrepo:b",
    "--no-focus",
    "--json",
  ]);
});

test("createWorktreeArgs: focus:true emits --focus", () => {
  const args = createWorktreeArgs({
    repoRoot: "/r",
    branch: "b",
    path: "/r.worktrees/b",
    focus: true,
  });
  assert.ok(args.includes("--focus"));
  assert.ok(!args.includes("--no-focus"));
});

test("createWorktreeArgs: --path is always present (never relies on Herdr's default layout)", () => {
  const args = createWorktreeArgs({
    repoRoot: "/r",
    branch: "b",
    path: "/r.worktrees/b",
  });
  const pathIdx = args.indexOf("--path");
  assert.ok(pathIdx !== -1);
  assert.equal(args[pathIdx + 1], "/r.worktrees/b");
});

// ---- extractWorktree ---------------------------------------------------------

test("extractWorktree: bare worktree object", () => {
  const w = extractWorktree({
    path: "/p",
    branch: "b",
    open_workspace_id: "w2",
  });
  assert.deepEqual(w, { path: "/p", branch: "b", label: undefined, openWorkspaceId: "w2" });
});

test("extractWorktree: wrapped under `worktree`", () => {
  const w = extractWorktree({ worktree: { path: "/p", branch: "b" } });
  assert.equal(w.path, "/p");
  assert.equal(w.branch, "b");
});

test("extractWorktree: first element of `worktrees` array", () => {
  const w = extractWorktree({
    worktrees: [{ path: "/p1", branch: "b1" }, { path: "/p2", branch: "b2" }],
  });
  assert.equal(w.path, "/p1");
  assert.equal(w.branch, "b1");
});

test("extractWorktree: camelCase fields are also tolerated", () => {
  const w = extractWorktree({ path: "/p", branch: "b", openWorkspaceId: "w9" });
  assert.equal(w.openWorkspaceId, "w9");
});

test("extractWorktree: garbage input returns empty object, not a throw", () => {
  assert.deepEqual(extractWorktree(null), {});
  assert.deepEqual(extractWorktree("nope"), {});
  assert.deepEqual(extractWorktree(42), {});
});
