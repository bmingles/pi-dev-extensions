import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveSandboxName } from "./name.ts";

const NAME_CHARSET = /^[a-z0-9.+-]+$/;

test("charset sanitization strips disallowed characters", () => {
  const name = deriveSandboxName("/home/u/My Project (v2)!");
  assert.match(name, NAME_CHARSET);
  assert.ok(name.startsWith("pi-"));
});

test("two different absolute paths with the same basename produce different names", () => {
  const a = deriveSandboxName("/home/alice/proj");
  const b = deriveSandboxName("/home/bob/proj");
  assert.notEqual(a, b);
});

test("output stays within a reasonable length budget", () => {
  const longBasename = "x".repeat(200);
  const name = deriveSandboxName(`/home/u/${longBasename}`);
  assert.ok(name.length < 64, `expected < 64 chars, got ${name.length}`);
});

test("stable across repeated calls with the same input", () => {
  const a = deriveSandboxName("/home/u/proj");
  const b = deriveSandboxName("/home/u/proj");
  assert.equal(a, b);
});

test("relative paths are resolved before naming (cwd-stable)", () => {
  const a = deriveSandboxName(process.cwd());
  const b = deriveSandboxName(".");
  assert.equal(a, b);
});

test("root path falls back to a non-empty basename", () => {
  const name = deriveSandboxName("/");
  assert.match(name, NAME_CHARSET);
  assert.ok(name.startsWith("pi-sandbox-") || name.startsWith("pi-"));
});

test("name never starts or ends the basename portion with a separator", () => {
  const name = deriveSandboxName("/home/u/---weird...");
  // Strip the pi- prefix and trailing -<hash> to inspect just the basename.
  const withoutPrefix = name.slice("pi-".length);
  const basename = withoutPrefix.slice(0, withoutPrefix.lastIndexOf("-"));
  assert.ok(!basename.startsWith("-"));
  assert.ok(!basename.startsWith("."));
  assert.ok(!basename.endsWith("-"));
  assert.ok(!basename.endsWith("."));
});
