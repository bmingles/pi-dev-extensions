import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SideProbe } from "pi-extension-core";
import factory from "./index.ts";

// This extension is host-only. These tests exercise only the side guard — see
// `side.test.ts` (in `shared/extension-core`) for `requireSide` itself, and
// `devcontainer/src/index.test.ts` for the fuller fake-pi harness this mirrors.

const hostProbe: SideProbe = { isContainer: () => false };
const containerProbe: SideProbe = { isContainer: () => true };

test("on the host side, the extension registers its tools and command", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  // `on` is a no-op: registering a real session_start listener (e.g. the one
  // that lazily starts the sandbox) must not fire it here.
  const pi = {
    registerTool: (t: { name: string }) => tools.push(t.name),
    registerCommand: (name: string) => commands.push(name),
    on: () => {},
  } as unknown as ExtensionAPI;
  factory(pi, hostProbe);
  assert.deepEqual(commands, ["sbx"]);
  assert.ok(tools.length > 0, "expected at least one tool to register");
});

test("on the container side, nothing registers and session_start notifies", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const notified: string[] = [];
  const pi = {
    registerTool: (t: { name: string }) => tools.push(t.name),
    registerCommand: (name: string) => commands.push(name),
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      if (event === "session_start") {
        handler({}, { ui: { notify: (msg: string) => notified.push(msg) } });
      }
    },
  } as unknown as ExtensionAPI;
  factory(pi, containerProbe);
  assert.deepEqual(tools, []);
  assert.deepEqual(commands, []);
  assert.equal(notified.length, 1);
  assert.match(notified[0], /sbx requires the host side/);
});
