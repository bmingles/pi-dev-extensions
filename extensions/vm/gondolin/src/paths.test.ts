import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { isHomeDirectory, toGuestPath } from "./paths.ts";

const HOST = "/home/u/proj";
const GUEST_WORKSPACE = "/workspace";

test("relative path resolves under guestWorkspace", () => {
  assert.equal(
    toGuestPath("src/a.ts", HOST, GUEST_WORKSPACE),
    "/workspace/src/a.ts",
  );
  assert.equal(
    toGuestPath("./src/a.ts", HOST, GUEST_WORKSPACE),
    "/workspace/src/a.ts",
  );
});

test("empty / whitespace resolves to guestWorkspace", () => {
  assert.equal(toGuestPath("", HOST, GUEST_WORKSPACE), GUEST_WORKSPACE);
  assert.equal(toGuestPath("   ", HOST, GUEST_WORKSPACE), GUEST_WORKSPACE);
});

test("guest-absolute path is kept as-is", () => {
  assert.equal(toGuestPath("/etc/hosts", HOST, GUEST_WORKSPACE), "/etc/hosts");
  assert.equal(
    toGuestPath("/workspace/x", HOST, GUEST_WORKSPACE),
    "/workspace/x",
  );
});

test("host-cwd-absolute path is rewritten into guestWorkspace", () => {
  assert.equal(
    toGuestPath("/home/u/proj/src/a.ts", HOST, GUEST_WORKSPACE),
    "/workspace/src/a.ts",
  );
  assert.equal(
    toGuestPath("/home/u/proj", HOST, GUEST_WORKSPACE),
    GUEST_WORKSPACE,
  );
});

test("@-prefix is stripped before mapping", () => {
  assert.equal(
    toGuestPath("@src/a.ts", HOST, GUEST_WORKSPACE),
    "/workspace/src/a.ts",
  );
  assert.equal(
    toGuestPath("@/home/u/proj/src/a.ts", HOST, GUEST_WORKSPACE),
    "/workspace/src/a.ts",
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
