import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { isHomeDirectory, toContainerPath } from "./paths.ts";

const HOST = "/home/u/proj";
const RWF = "/workspaces/proj";

test("relative path resolves under remoteWorkspaceFolder", () => {
  assert.equal(
    toContainerPath("src/a.ts", HOST, RWF),
    "/workspaces/proj/src/a.ts",
  );
  assert.equal(
    toContainerPath("./src/a.ts", HOST, RWF),
    "/workspaces/proj/src/a.ts",
  );
});

test("empty / whitespace resolves to remoteWorkspaceFolder", () => {
  assert.equal(toContainerPath("", HOST, RWF), RWF);
  assert.equal(toContainerPath("   ", HOST, RWF), RWF);
});

test("container-absolute path is kept as-is", () => {
  assert.equal(toContainerPath("/etc/hosts", HOST, RWF), "/etc/hosts");
  assert.equal(
    toContainerPath("/workspaces/proj/x", HOST, RWF),
    "/workspaces/proj/x",
  );
});

test("host-cwd-absolute path is rewritten into remoteWorkspaceFolder", () => {
  assert.equal(
    toContainerPath("/home/u/proj/src/a.ts", HOST, RWF),
    "/workspaces/proj/src/a.ts",
  );
  assert.equal(toContainerPath("/home/u/proj", HOST, RWF), RWF);
});

test("@-prefix is stripped before mapping", () => {
  assert.equal(
    toContainerPath("@src/a.ts", HOST, RWF),
    "/workspaces/proj/src/a.ts",
  );
  assert.equal(
    toContainerPath("@/home/u/proj/src/a.ts", HOST, RWF),
    "/workspaces/proj/src/a.ts",
  );
});

test("isHomeDirectory: exact match is home", () => {
  assert.equal(isHomeDirectory("/home/u", "/home/u"), true);
});

test("isHomeDirectory: trailing slash is normalized", () => {
  assert.equal(isHomeDirectory("/home/u/", "/home/u"), true);
});

test("isHomeDirectory: subpath of home is not home", () => {
  assert.equal(isHomeDirectory("/home/u/code/foo", "/home/u"), false);
});

test("isHomeDirectory: parent of home is not home", () => {
  assert.equal(isHomeDirectory(path.dirname("/home/u"), "/home/u"), false);
});

test("isHomeDirectory: unrelated path is not home", () => {
  assert.equal(isHomeDirectory("/completely/unrelated", "/home/u"), false);
});
