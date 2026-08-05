import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { isHomeDirectory } from "./paths.ts";

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
