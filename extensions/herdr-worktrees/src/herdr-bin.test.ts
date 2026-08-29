import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHerdrBin } from "./herdr-bin.ts";

// HERDR_BIN_PATH / HERDR_BIN short-circuit before any filesystem walk, so
// these are deterministic without touching the real PATH.

test("resolveHerdrBin: HERDR_BIN_PATH wins over everything else", () => {
  const bin = resolveHerdrBin({
    HERDR_BIN_PATH: "/pane/herdr-bin",
    HERDR_BIN: "/other/herdr",
    PATH: "/usr/bin",
  });
  assert.equal(bin, "/pane/herdr-bin");
});

test("resolveHerdrBin: HERDR_BIN wins when HERDR_BIN_PATH is unset", () => {
  const bin = resolveHerdrBin({ HERDR_BIN: "/other/herdr", PATH: "/usr/bin" });
  assert.equal(bin, "/other/herdr");
});

test("resolveHerdrBin: falls back to bare 'herdr' when nothing resolves on PATH", () => {
  const bin = resolveHerdrBin({ PATH: "/nonexistent-dir-xyz" });
  assert.equal(bin, "herdr");
});
