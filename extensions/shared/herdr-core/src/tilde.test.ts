import assert from "node:assert/strict";
import { test } from "node:test";
import { expandTilde } from "./tilde.ts";

// ---- expandTilde ------------------------------------------------------------
// These tools are called by a model, not a shell, so nothing upstream expands `~`.
// Found on a real host run: `repo: ~/code/tools/devc-tools` produced NOT_A_REPO naming
// '/Users/bingles/code/tools/devc-dev/~/code/tools/devc-tools'.

test("expandTilde expands a leading ~/", () => {
  assert.equal(
    expandTilde("~/code/tools/devc-tools", "/Users/me"),
    "/Users/me/code/tools/devc-tools",
  );
});

test("expandTilde expands a bare ~", () => {
  assert.equal(expandTilde("~", "/Users/me"), "/Users/me");
});

test("expandTilde leaves everything else alone", () => {
  assert.equal(expandTilde("/abs/path", "/Users/me"), "/abs/path");
  assert.equal(expandTilde("rel/path", "/Users/me"), "rel/path");
  // A path that merely starts with a tilde is not a home reference.
  assert.equal(expandTilde("~file", "/Users/me"), "~file");
  // ~user needs a passwd lookup; guessing would be wrong as often as not.
  assert.equal(expandTilde("~other/code", "/Users/me"), "~other/code");
  assert.equal(expandTilde("", "/Users/me"), "");
});
