import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHerdr } from "./herdr-cli.ts";

/**
 * `runHerdr` spawns a real process (`shell: false`) and parses its stdout, so it is tested
 * against a real fake `herdr` — a tiny script on disk, pointed to via `HERDR_BIN_PATH` (the
 * same env var `resolveHerdrBin` checks first) — rather than a mocked `child_process`. That
 * is the only way to exercise the actual spawn/parse path, including the case this file
 * exists for: a clean exit with genuinely empty output.
 */
function fakeHerdr(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-cli-test-"));
  const path = join(dir, "herdr");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

function envWith(bin: string): NodeJS.ProcessEnv {
  return { ...process.env, HERDR_BIN_PATH: bin };
}

test("runHerdr parses a {result} envelope as ok", async () => {
  const bin = fakeHerdr(`echo '{"result": {"pane_id": "%1"}}'`);
  const r = await runHerdr(["pane", "split"], { env: envWith(bin) });
  assert.deepEqual(r, { ok: true, data: { pane_id: "%1" } });
});

test("runHerdr parses a {error} envelope as a failure", async () => {
  const bin = fakeHerdr(`echo '{"error": {"message": "no such pane"}}'`);
  const r = await runHerdr(["pane", "get", "x"], { env: envWith(bin) });
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /no such pane/);
});

test("runHerdr fails a clean exit with empty output by default", async () => {
  const bin = fakeHerdr(`exit 0`);
  const r = await runHerdr(["pane", "run", "%1", "true"], { env: envWith(bin) });
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /exited 0 with no parseable output/);
});

test("runHerdr's tolerateEmptySuccess accepts that same clean, empty exit", async () => {
  // Live-verified: `pane run` on at least one Herdr build exits 0 with nothing on stdout
  // for a command that genuinely ran — this is the case that broke `devcontainer_herdr_
  // start_agent` for a launch that had actually worked.
  const bin = fakeHerdr(`exit 0`);
  const r = await runHerdr(["pane", "run", "%1", "true"], {
    env: envWith(bin),
    tolerateEmptySuccess: true,
  });
  assert.deepEqual(r, { ok: true, data: undefined });
});

test("tolerateEmptySuccess does not mask a nonzero exit", async () => {
  const bin = fakeHerdr(`exit 1`);
  const r = await runHerdr(["pane", "run", "%1", "true"], {
    env: envWith(bin),
    tolerateEmptySuccess: true,
  });
  assert.equal(r.ok, false);
});

test("tolerateEmptySuccess does not mask stderr output on a clean exit", async () => {
  const bin = fakeHerdr(`echo 'deprecation warning' >&2; exit 0`);
  const r = await runHerdr(["pane", "run", "%1", "true"], {
    env: envWith(bin),
    tolerateEmptySuccess: true,
  });
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /deprecation warning/);
});
