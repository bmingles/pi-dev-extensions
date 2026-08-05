import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  DevcInfraError,
  devcUp,
  getMounts,
  runInContainer,
  type SpawnFn,
} from "./devc.ts";

interface FakeBehavior {
  stdout?: string;
  stderr?: string;
  code?: number;
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

test("devcUp issues `devc up <cwd> --json` and parses the JSON", async () => {
  const info = {
    containerId: "abc123",
    remoteUser: "vscode",
    remoteWorkspaceFolder: "/workspaces/proj",
    remoteEnv: { FOO: "bar" },
  };
  const { spawn, calls } = makeSpawn({ stdout: JSON.stringify(info), code: 0 });

  const result = await devcUp("/host/proj", spawn);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "devc");
  assert.deepEqual(calls[0].args, ["up", "/host/proj", "--json"]);
  assert.deepEqual(result, info);
});

test("devcUp parses the final line when progress precedes the JSON", async () => {
  const info = {
    containerId: "id",
    remoteUser: "root",
    remoteWorkspaceFolder: "/workspaces/x",
    remoteEnv: {},
  };
  const { spawn } = makeSpawn({
    stdout: `starting...\n${JSON.stringify(info)}\n`,
    code: 0,
  });
  assert.deepEqual(await devcUp("/host", spawn), info);
});

test("devcUp throws DevcInfraError on non-zero exit", async () => {
  const { spawn } = makeSpawn({ stderr: "boom", code: 1 });
  await assert.rejects(() => devcUp("/host", spawn), DevcInfraError);
});

test("runInContainer builds `devc exec` with --cwd, --env and `--`, pipes stdin", async () => {
  const { spawn, calls } = makeSpawn({ stdout: "ok", code: 0 });

  const result = await runInContainer(
    "/host/proj",
    ["cat", "--", "/workspaces/proj/a.ts"],
    { cwd: "/workspaces/proj/sub", env: { A: "1", B: "2" }, stdin: "hello" },
    spawn,
  );

  assert.deepEqual(calls[0].args, [
    "exec",
    "/host/proj",
    "--cwd",
    "/workspaces/proj/sub",
    "--env",
    "A=1",
    "--env",
    "B=2",
    "--",
    "cat",
    "--",
    "/workspaces/proj/a.ts",
  ]);
  assert.equal(Buffer.concat(calls[0].stdin).toString("utf8"), "hello");
  assert.equal(result.code, 0);
  assert.equal(new TextDecoder().decode(result.stdout), "ok");
});

test("runInContainer omits --cwd/--env when not provided", async () => {
  const { spawn, calls } = makeSpawn({ code: 0 });
  await runInContainer("/host", ["ls"], {}, spawn);
  assert.deepEqual(calls[0].args, ["exec", "/host", "--", "ls"]);
});

test("runInContainer forwards chunks to onStdout/onStderr", async () => {
  const { spawn } = makeSpawn({ stdout: "OUT", stderr: "ERR", code: 0 });
  const out: string[] = [];
  const err: string[] = [];
  await runInContainer(
    "/host",
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

test("runInContainer maps exit code 125 to a DevcInfraError", async () => {
  const { spawn } = makeSpawn({ stderr: "docker down", code: 125 });
  await assert.rejects(
    () => runInContainer("/host", ["cat", "x"], {}, spawn),
    DevcInfraError,
  );
});

test("runInContainer returns a normal non-zero exit (not 125) as a result", async () => {
  const { spawn } = makeSpawn({ code: 1 });
  const result = await runInContainer("/host", ["false"], {}, spawn);
  assert.equal(result.code, 1);
});

test("getMounts issues `devc mounts <cwd> --json` and parses the array", async () => {
  const mounts = [
    {
      type: "bind",
      source: "/host/proj",
      destination: "/workspaces/proj",
      rw: true,
    },
    {
      type: "volume",
      source: "/var/lib/docker/volumes/nm/_data",
      destination: "/workspaces/proj/node_modules",
      rw: true,
    },
  ];
  const { spawn, calls } = makeSpawn({
    stdout: JSON.stringify(mounts),
    code: 0,
  });

  const result = await getMounts("/host/proj", spawn);

  assert.equal(calls[0].command, "devc");
  assert.deepEqual(calls[0].args, ["mounts", "/host/proj", "--json"]);
  assert.deepEqual(result, mounts);
});

test("getMounts returns [] when devc reports no container", async () => {
  const { spawn } = makeSpawn({ stdout: "[]", code: 0 });
  assert.deepEqual(await getMounts("/host", spawn), []);
});

test("getMounts throws DevcInfraError on non-zero exit", async () => {
  const { spawn } = makeSpawn({ stderr: "boom", code: 1 });
  await assert.rejects(() => getMounts("/host", spawn), DevcInfraError);
});

test("$DEVC_BIN overrides the executable and prepends its extra tokens", async () => {
  const prev = process.env.DEVC_BIN;
  process.env.DEVC_BIN =
    "deno run --allow-run=docker /repo/devc/main.ts";
  try {
    const info = {
      containerId: "id",
      remoteUser: "vscode",
      remoteWorkspaceFolder: "/workspaces/p",
      remoteEnv: {},
    };
    const { spawn, calls } = makeSpawn({
      stdout: JSON.stringify(info),
      code: 0,
    });
    await devcUp("/host/p", spawn);
    assert.equal(calls[0].command, "deno");
    assert.deepEqual(calls[0].args, [
      "run",
      "--allow-run=docker",
      "/repo/devc/main.ts",
      "up",
      "/host/p",
      "--json",
    ]);
  } finally {
    if (prev === undefined) delete process.env.DEVC_BIN;
    else process.env.DEVC_BIN = prev;
  }
});
