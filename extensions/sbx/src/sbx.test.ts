import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { deriveSandboxName } from "./name.ts";
import {
  runInSandbox,
  SbxInfraError,
  sbxUp,
  type SpawnFn,
} from "./sbx.ts";

interface FakeBehavior {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** If set, emit a child "error" event instead of "close". */
  spawnError?: Error;
}

interface SpawnCall {
  command: string;
  args: string[];
  stdin: Buffer[];
}

/** Builds an injectable spawn that records calls and emits canned output. */
function makeSpawn(behavior: FakeBehavior = {}) {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (command, args) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: () => void;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.kill = () => {};

    const record: SpawnCall = { command, args: [...args], stdin: [] };
    stdin.on("data", (chunk: Buffer) => record.stdin.push(Buffer.from(chunk)));
    calls.push(record);

    setImmediate(() => {
      if (behavior.spawnError) {
        child.emit("error", behavior.spawnError);
        return;
      }
      if (behavior.stdout) stdout.write(behavior.stdout);
      if (behavior.stderr) stderr.write(behavior.stderr);
      stdout.end();
      stderr.end();
      setImmediate(() => child.emit("close", behavior.code ?? 0));
    });

    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

test("sbxUp issues `sbx run --name <derived-name> -d shell <hostCwd>`", async () => {
  const hostCwd = "/home/u/proj";
  const name = deriveSandboxName(hostCwd);
  const { spawn, calls } = makeSpawn({ stdout: "sandbox-id-123\n", code: 0 });

  const info = await sbxUp(hostCwd, spawn);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "sbx");
  assert.deepEqual(calls[0].args, [
    "run",
    "--name",
    name,
    "-d",
    "shell",
    hostCwd,
  ]);
  assert.deepEqual(info, { name, sandboxId: "sandbox-id-123", workspace: hostCwd });
});

test("sbxUp parses the last non-empty stdout line as sandboxId", async () => {
  const hostCwd = "/home/u/proj";
  const { spawn } = makeSpawn({
    stdout: "pulling image...\nstarting...\nsandbox-id-abc\n",
    code: 0,
  });
  const info = await sbxUp(hostCwd, spawn);
  assert.equal(info.sandboxId, "sandbox-id-abc");
});

test("sbxUp throws SbxInfraError on non-zero exit", async () => {
  const { spawn } = makeSpawn({ stderr: "boom", code: 1 });
  await assert.rejects(() => sbxUp("/host", spawn), SbxInfraError);
});

test("sbxUp throws SbxInfraError on a spawn failure (e.g. sbx missing from PATH)", async () => {
  const { spawn } = makeSpawn({ spawnError: new Error("ENOENT") });
  await assert.rejects(() => sbxUp("/host", spawn), SbxInfraError);
});

test("runInSandbox builds `sbx exec -i -w <cwd> -e K=V... <name> <argv...>`, pipes stdin", async () => {
  const { spawn, calls } = makeSpawn({ stdout: "ok", code: 0 });

  const result = await runInSandbox(
    "pi-proj-abcdef12",
    ["cat", "--", "/home/u/proj/a.ts"],
    { cwd: "/home/u/proj/sub", env: { A: "1", B: "2" }, stdin: "hello" },
    spawn,
  );

  assert.equal(calls[0].command, "sbx");
  assert.deepEqual(calls[0].args, [
    "exec",
    "-i",
    "-w",
    "/home/u/proj/sub",
    "-e",
    "A=1",
    "-e",
    "B=2",
    "pi-proj-abcdef12",
    "cat",
    "--",
    "/home/u/proj/a.ts",
  ]);
  assert.equal(Buffer.concat(calls[0].stdin).toString("utf8"), "hello");
  assert.equal(result.code, 0);
  assert.equal(new TextDecoder().decode(result.stdout), "ok");
});

test("runInSandbox omits -w/-e when not provided", async () => {
  const { spawn, calls } = makeSpawn({ code: 0 });
  await runInSandbox("pi-x-00000000", ["ls"], {}, spawn);
  assert.deepEqual(calls[0].args, ["exec", "-i", "pi-x-00000000", "ls"]);
});

test("runInSandbox forwards chunks to onStdout/onStderr", async () => {
  const { spawn } = makeSpawn({ stdout: "OUT", stderr: "ERR", code: 0 });
  const out: string[] = [];
  const err: string[] = [];
  await runInSandbox(
    "pi-x-00000000",
    ["echo"],
    {
      onStdout: (c) => out.push(new TextDecoder().decode(c)),
      onStderr: (c) => err.push(new TextDecoder().decode(c)),
    },
    spawn,
  );
  assert.equal(out.join(""), "OUT");
  assert.equal(err.join(""), "ERR");
});

test("runInSandbox resolves with the child's real exit code, never a special-cased 125", async () => {
  const { spawn } = makeSpawn({ code: 125 });
  const result = await runInSandbox("pi-x-00000000", ["false"], {}, spawn);
  assert.equal(result.code, 125);
});

test("runInSandbox resolves (not rejects) on a normal non-zero exit", async () => {
  const { spawn } = makeSpawn({ code: 1 });
  const result = await runInSandbox("pi-x-00000000", ["false"], {}, spawn);
  assert.equal(result.code, 1);
});

test("runInSandbox rejects on a spawn-level failure", async () => {
  const { spawn } = makeSpawn({ spawnError: new Error("ENOENT") });
  await assert.rejects(
    () => runInSandbox("pi-x-00000000", ["ls"], {}, spawn),
    /ENOENT/,
  );
});
