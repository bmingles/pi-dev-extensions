import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SideProbe } from "pi-extension-core";
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

/** This extension's declared side. Fixed regardless of the real `/.dockerenv` probe, which
 * is meaningless here — these tests run inside this repo's own devcontainer, so the real
 * probe would always report "container" and every "on the right side" test below would see
 * zero tools. Fake-pi tests exercise `requireSide` via the injected probe instead — see
 * `side.test.ts` (in `shared/extension-core`) for `requireSide` itself. */
const hostProbe: SideProbe = { isContainer: () => false };
const containerProbe: SideProbe = { isContainer: () => true };

/** Load the extension against a fake pi (on the host side, unless `probe` overrides it) and
 * report the tool names it registered. */
function load(
  env: Record<string, string | undefined>,
  probe: SideProbe = hostProbe,
): string[] {
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
    factory(pi, probe);
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

// ---- side guard --------------------------------------------------------
// This extension is host-only. Loaded on the container side, `requireSide` must refuse
// before registering anything — see § Why item 1 in the extensions-topology-split plan.

test("on the container side, nothing registers", () => {
  assert.deepEqual(
    load({ HERDR_BIN_PATH: undefined, HERDR_BIN: undefined, PATH: "" }, containerProbe),
    [],
  );
});

test("on the container side, session_start notifies of the refusal", () => {
  const saved = { ...process.env };
  process.env.PATH = "";
  delete process.env.HERDR_BIN_PATH;
  delete process.env.HERDR_BIN;
  try {
    const notified: string[] = [];
    const pi = {
      registerTool: () => {},
      registerCommand: () => {},
      on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
        if (event === "session_start") {
          handler({}, { ui: { notify: (msg: string) => notified.push(msg) } });
        }
      },
    } as unknown as ExtensionAPI;
    factory(pi, containerProbe);
    assert.equal(notified.length, 1);
    assert.match(notified[0], /devcontainer requires the host side/);
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
