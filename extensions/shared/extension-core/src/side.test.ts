import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectSide, requireSide, type SideProbe } from "./side.ts";

const containerProbe: SideProbe = { isContainer: () => true };
const hostProbe: SideProbe = { isContainer: () => false };

test("detectSide reports container when the probe says so", () => {
  assert.equal(detectSide(containerProbe), "container");
});

test("detectSide reports host when the probe says so", () => {
  assert.equal(detectSide(hostProbe), "host");
});

/** A minimal fake pi that captures `session_start` notifications without ever firing them
 * itself — `requireSide` registers the handler synchronously and returns; nothing else in
 * this test harness invokes it, so asserting on `notified` after the call is enough to prove
 * whether one was registered. */
function fakePi(): { pi: ExtensionAPI; fireSessionStart(): void; notified: string[] } {
  const notified: string[] = [];
  let handler: ((event: unknown, ctx: unknown) => void) | undefined;
  const pi = {
    on: (event: string, h: (event: unknown, ctx: unknown) => void) => {
      if (event === "session_start") handler = h;
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    fireSessionStart: () => {
      handler?.({}, { ui: { notify: (msg: string) => notified.push(msg) } });
    },
    notified,
  };
}

test("requireSide returns true and registers nothing when the side matches", () => {
  const { pi, fireSessionStart, notified } = fakePi();
  assert.equal(requireSide("container", pi, "herdr-worktrees", containerProbe), true);
  fireSessionStart();
  assert.deepEqual(notified, []);
});

test("requireSide returns false and notifies when the side does not match", () => {
  const { pi, fireSessionStart, notified } = fakePi();
  assert.equal(requireSide("container", pi, "herdr-worktrees", hostProbe), false);
  fireSessionStart();
  assert.equal(notified.length, 1);
  assert.match(notified[0], /herdr-worktrees/);
  assert.match(notified[0], /requires the container side/);
  assert.match(notified[0], /running on the host side/);
});

test("requireSide on the host side, expecting host, returns true", () => {
  const { pi, fireSessionStart, notified } = fakePi();
  assert.equal(requireSide("host", pi, "devcontainer", hostProbe), true);
  fireSessionStart();
  assert.deepEqual(notified, []);
});

test("requireSide expecting host but running in a container returns false", () => {
  const { pi, fireSessionStart, notified } = fakePi();
  assert.equal(requireSide("host", pi, "devcontainer", containerProbe), false);
  fireSessionStart();
  assert.equal(notified.length, 1);
  assert.match(notified[0], /requires the host side/);
  assert.match(notified[0], /running on the container side/);
});
