import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  isSupportedPlatform,
  resolveArgs,
  startCaffeinate,
  type SpawnFn,
} from "./caffeinate.ts";

interface SpawnCall {
  command: string;
  args: string[];
}

/** Builds an injectable spawn that records calls and returns a controllable fake child. */
function makeSpawn() {
  const calls: SpawnCall[] = [];
  const children: Array<
    EventEmitter & { pid: number; killed: boolean; kill: () => void }
  > = [];
  let nextPid = 1000;

  const spawn: SpawnFn = (command, args) => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      killed: boolean;
      kill: () => void;
    };
    child.pid = nextPid++;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    calls.push({ command, args: [...args] });
    children.push(child);
    return child as unknown as ChildProcess;
  };

  return { spawn, calls, children };
}

test("isSupportedPlatform is true only for darwin", () => {
  assert.equal(isSupportedPlatform("darwin"), true);
  assert.equal(isSupportedPlatform("linux"), false);
  assert.equal(isSupportedPlatform("win32"), false);
});

test("resolveArgs defaults to -i", () => {
  assert.deepEqual(resolveArgs({}), ["-i"]);
});

test("resolveArgs splits $PI_CAFFEINATE_ARGS on whitespace", () => {
  assert.deepEqual(resolveArgs({ PI_CAFFEINATE_ARGS: "-d -i  -s" }), [
    "-d",
    "-i",
    "-s",
  ]);
});

test("resolveArgs ignores a blank override", () => {
  assert.deepEqual(resolveArgs({ PI_CAFFEINATE_ARGS: "   " }), ["-i"]);
});

test("startCaffeinate spawns `caffeinate <args>`", () => {
  const { spawn, calls } = makeSpawn();
  startCaffeinate(["-i"], spawn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "caffeinate");
  assert.deepEqual(calls[0].args, ["-i"]);
});

test("startCaffeinate defaults to resolveArgs() when no args are given", () => {
  const { spawn, calls } = makeSpawn();
  startCaffeinate(undefined, spawn);
  assert.deepEqual(calls[0].args, ["-i"]);
});

test("stop() kills the underlying child exactly once", () => {
  const { spawn, children } = makeSpawn();
  const handle = startCaffeinate(["-i"], spawn);
  assert.equal(handle.pid, children[0].pid);

  handle.stop();
  assert.equal(children[0].killed, true);

  children[0].killed = false; // prove the second stop() is a no-op
  handle.stop();
  assert.equal(children[0].killed, false);
});

test("stop() is a no-op once the child has already errored", () => {
  const { spawn, children } = makeSpawn();
  const errors: Error[] = [];
  const handle = startCaffeinate(["-i"], spawn, (err) => errors.push(err));

  children[0].emit("error", new Error("ENOENT"));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "ENOENT");

  handle.stop();
  assert.equal(children[0].killed, false);
});
