import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import factory, { readyMessage, statusLine } from "./index.ts";

/** The tools this extension has always registered, with no Herdr anywhere. */
const BASELINE = [
  "read",
  "write",
  "edit",
  "bash",
  "ls",
  "find",
  "grep",
  "read_host",
  "list_host_docs",
];

/** Load the extension against a fake pi and report the tool names it registered. */
function load(env: Record<string, string | undefined>): string[] {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const names: string[] = [];
    const pi = {
      registerTool: (t: { name: string }) => names.push(t.name),
      registerCommand: () => {},
      on: () => {},
    } as unknown as ExtensionAPI;
    factory(pi);
    return names;
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("with no herdr resolvable, exactly the existing tools register", () => {
  // An ordinary `pic` session must not gain three tools it cannot use.
  assert.deepEqual(
    load({ HERDR_BIN_PATH: undefined, HERDR_BIN: undefined, PATH: "" }),
    BASELINE,
  );
});

test("with HERDR_BIN_PATH set, the three Herdr tools register alongside them", () => {
  const names = load({
    HERDR_BIN_PATH: "/opt/herdr/bin/herdr",
    HERDR_BIN: undefined,
    PATH: "",
  });
  assert.deepEqual(names.slice(0, BASELINE.length), BASELINE);
  assert.deepEqual(names.slice(BASELINE.length), [
    "devcontainer_herdr_worktree_path",
    "devcontainer_herdr_worktree_create",
    "devcontainer_herdr_start_agent",
  ]);
});

test("HERDR_BIN also arms the gate", () => {
  const names = load({
    HERDR_BIN_PATH: undefined,
    HERDR_BIN: "herdr-nightly",
    PATH: "",
  });
  assert.ok(names.includes("devcontainer_herdr_start_agent"));
});

test("the Herdr tools override nothing — the baseline is untouched either way", () => {
  const off = load({ HERDR_BIN_PATH: undefined, HERDR_BIN: undefined, PATH: "" });
  const on = load({ HERDR_BIN_PATH: "/opt/herdr/bin/herdr", PATH: "" });
  assert.deepEqual(off, BASELINE);
  assert.equal(new Set(on).size, on.length, "no tool registered twice");
});

// ---- discoverability --------------------------------------------------------
// The Herdr tools register silently by design — a session without Herdr must see nothing.
// The cost is that a session WITH Herdr got no confirmation either, and in practice the
// status line below was mistaken for `/devcontainer`'s output, leaving "did they load?"
// unanswered by the surface actually being read.

test("the status line marks the Herdr tools when they registered", () => {
  assert.equal(
    statusLine("1ca7c3d6720d6df4dd54ebdf", "/workspaces/devc-dev", true),
    "devcontainer: 1ca7c3d6720d (/workspaces/devc-dev) +herdr",
  );
});

test("the status line is unchanged for a session without Herdr", () => {
  assert.equal(
    statusLine("1ca7c3d6720d6df4dd54ebdf", "/workspaces/devc-dev", false),
    "devcontainer: 1ca7c3d6720d (/workspaces/devc-dev)",
  );
});

test("the ready notification names the tools when they registered", () => {
  assert.match(readyMessage("/workspaces/x", true), /devcontainer_herdr_\*/);
  assert.equal(
    readyMessage("/workspaces/x", false),
    "devcontainer ready. Tools routed into /workspaces/x.",
  );
});
