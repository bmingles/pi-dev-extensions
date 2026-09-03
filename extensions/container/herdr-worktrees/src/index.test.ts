import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SideProbe } from "pi-extension-core";
import factory from "./index.ts";

// This extension is container-only — the opposite direction from the host
// extensions (see `devcontainer/src/index.test.ts`). This is the defect the
// extensions-topology-split plan set out to fix: loaded on the host, this
// extension's own mount guard used to be skipped entirely (gated on
// `ResolveDeps.isContainer`), reporting success for any path without
// checking it. `requireSide` now refuses before registering anything.

const hostProbe: SideProbe = { isContainer: () => false };
const containerProbe: SideProbe = { isContainer: () => true };

function load(probe: SideProbe): { tools: string[]; notified: string[] } {
  const tools: string[] = [];
  const notified: string[] = [];
  const pi = {
    registerTool: (t: { name: string }) => tools.push(t.name),
    registerCommand: () => {},
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      if (event === "session_start") {
        handler({}, { ui: { notify: (msg: string) => notified.push(msg) } });
      }
    },
  } as unknown as ExtensionAPI;
  factory(pi, probe);
  return { tools, notified };
}

test("on the container side, both tools register", () => {
  const { tools, notified } = load(containerProbe);
  assert.deepEqual(tools, ["herdr_devc_worktree_path", "herdr_devc_worktree_create"]);
  assert.deepEqual(notified, []);
});

test("on the host side, nothing registers and session_start notifies", () => {
  const { tools, notified } = load(hostProbe);
  assert.deepEqual(tools, []);
  assert.equal(notified.length, 1);
  assert.match(notified[0], /herdr-worktrees requires the container side/);
});
