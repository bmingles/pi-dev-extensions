import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ContainerInfo, ContainerMount } from "@devc-tools/core";
import { logNotice, logWarning } from "@devc-tools/core";
import {
  DevcInfraError,
  ensureContainer,
  getMounts,
  isContainerRunning,
  runInContainer,
  type SpawnFn,
} from "./container.ts";

const INFO: ContainerInfo = {
  containerId: "abc123",
  remoteUser: "vscode",
  remoteWorkspaceFolder: "/workspaces/proj",
  remoteEnv: {},
};

interface FakeBehavior {
  stdout?: string | Uint8Array;
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

// --- ensureContainer -------------------------------------------------------
//
// Core's `startContainer` and its devcontainer-CLI runner are injected, so
// these exercise the extension's wiring (which runner is built, where core's
// output goes, how a failure is surfaced) without Docker or a real container.

test("ensureContainer starts the container for the host cwd, without rebuilding", async () => {
  const calls: Array<{ folder: string; rebuild: boolean | undefined }> = [];
  const info = await ensureContainer("/host/proj", {
    start: (folder, rebuild) => {
      calls.push({ folder, rebuild });
      return Promise.resolve(INFO);
    },
  });
  assert.deepEqual(calls, [{ folder: "/host/proj", rebuild: false }]);
  assert.deepEqual(info, INFO);
});

test("ensureContainer passes a runner with an onStderr sink, never the inheriting default", async () => {
  let sawRunner = false;
  let sawSink = false;
  await ensureContainer("/host", {
    start: (_folder, _rebuild, opts) => {
      sawRunner = opts?.devcontainer !== undefined;
      return Promise.resolve(INFO);
    },
    createRunner: (opts) => {
      sawSink = typeof opts.onStderr === "function";
      return { run: () => Promise.resolve({ code: 0, stdout: "" }) };
    },
  });
  assert.ok(sawRunner, "startContainer receives a DevcontainerRunner");
  assert.ok(sawSink, "the runner is built with an onStderr callback");
});

test("ensureContainer rethrows a start failure as DevcInfraError", async () => {
  await assert.rejects(
    () =>
      ensureContainer("/host", {
        start: () => Promise.reject(new Error("devcontainer up failed")),
      }),
    (err: unknown) => {
      assert.ok(err instanceof DevcInfraError);
      assert.match(err.message, /devcontainer up failed/);
      return true;
    },
  );
});

test("ensureContainer appends the devcontainer CLI's stderr to a failed start", async () => {
  let sink: ((chunk: Uint8Array) => void) | undefined;
  await assert.rejects(
    () =>
      ensureContainer("/host", {
        createRunner: (opts) => {
          sink = opts.onStderr;
          return { run: () => Promise.resolve({ code: 1, stdout: "" }) };
        },
        start: () => {
          // What a cold build looks like: the CLI streams to the sink, then
          // core throws with a message that says nothing about why.
          sink?.(new TextEncoder().encode("ERROR: failed to solve\n"));
          return Promise.reject(new Error("devcontainer up failed"));
        },
      }),
    /ERROR: failed to solve/,
  );
});

test("ensureContainer keeps a log message off the end of a stderr chunk", async () => {
  // The buffer is joined with `""` (stderr arrives as partial chunks), so a
  // whole logger message needs its own terminator or it is glued onto the
  // chunk that follows.
  let sink: ((chunk: Uint8Array) => void) | undefined;
  await assert.rejects(
    () =>
      ensureContainer("/host", {
        createRunner: (opts) => {
          sink = opts.onStderr;
          return { run: () => Promise.resolve({ code: 1, stdout: "" }) };
        },
        start: () => {
          logWarning("devc: could not rename container");
          sink?.(new TextEncoder().encode("ERROR: failed to solve\n"));
          return Promise.reject(new Error("devcontainer up failed"));
        },
      }),
    (err: Error) => {
      assert.match(err.message, /could not rename container\nERROR: failed/);
      return true;
    },
  );
});

test("ensureContainer captures core's own log output rather than letting it reach the console", async () => {
  // `setLogger` is installed by container.ts at module load; these are core's
  // real emit functions, so this asserts the seam end to end.
  await assert.rejects(
    () =>
      ensureContainer("/host", {
        start: () => {
          logNotice("devc: created ~/.devc/claude");
          logWarning("devc: skipped a mount");
          return Promise.reject(new Error("boom"));
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof DevcInfraError);
      assert.match(err.message, /notice: devc: created/);
      assert.match(err.message, /warning: devc: skipped a mount/);
      return true;
    },
  );
});

test("ensureContainer discards the buffered output of a successful start", async () => {
  await ensureContainer("/host", {
    start: () => {
      logNotice("first run chatter");
      return Promise.resolve(INFO);
    },
  });
  // A later failure must not inherit the previous start's lines.
  await assert.rejects(
    () =>
      ensureContainer("/host", {
        start: () => Promise.reject(new Error("boom")),
      }),
    (err: unknown) => {
      assert.ok(err instanceof DevcInfraError);
      assert.doesNotMatch(err.message, /first run chatter/);
      return true;
    },
  );
});

// --- runInContainer --------------------------------------------------------

test("runInContainer spawns `docker exec` with -i, -u, -w and the argv (no `--` separator)", async () => {
  const { spawn, calls } = makeSpawn({ stdout: "ok", code: 0 });

  const result = await runInContainer(
    INFO,
    ["cat", "--", "/workspaces/proj/a.ts"],
    { cwd: "/workspaces/proj/sub", env: { A: "1", B: "2" }, stdin: "hello" },
    spawn,
  );

  assert.equal(calls[0].command, "docker");
  assert.deepEqual(calls[0].args, [
    "exec",
    "-i",
    "-e",
    "A=1",
    "-e",
    "B=2",
    "-u",
    "vscode",
    "-w",
    "/workspaces/proj/sub",
    "abc123",
    "cat",
    "--",
    "/workspaces/proj/a.ts",
  ]);
  assert.equal(Buffer.concat(calls[0].stdin).toString("utf8"), "hello");
  assert.equal(result.code, 0);
  assert.equal(new TextDecoder().decode(result.stdout), "ok");
});

test("runInContainer defaults the cwd to remoteWorkspaceFolder and carries remoteEnv", async () => {
  const { spawn, calls } = makeSpawn({ code: 0 });
  await runInContainer(
    { ...INFO, remoteEnv: { PATH: "/usr/bin" } },
    ["ls"],
    {},
    spawn,
  );
  assert.deepEqual(calls[0].args, [
    "exec",
    "-i",
    "-e",
    "PATH=/usr/bin",
    "-u",
    "vscode",
    "-w",
    "/workspaces/proj",
    "abc123",
    "ls",
  ]);
});

test("runInContainer keeps stdout as bytes, so binary files survive the round trip", async () => {
  // A PNG magic number with a 0x89 byte no UTF-8 decode would preserve.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { spawn } = makeSpawn({ stdout: png, code: 0 });
  const result = await runInContainer(INFO, ["cat", "--", "x.png"], {}, spawn);
  assert.deepEqual(Buffer.from(result.stdout), png);
});

test("runInContainer forwards chunks to onStdout/onStderr", async () => {
  const { spawn } = makeSpawn({ stdout: "OUT", stderr: "ERR", code: 0 });
  const out: string[] = [];
  const err: string[] = [];
  await runInContainer(
    INFO,
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
    () => runInContainer(INFO, ["cat", "x"], {}, spawn),
    DevcInfraError,
  );
});

test("runInContainer returns a normal non-zero exit (not 125) as a result", async () => {
  const { spawn } = makeSpawn({ code: 1 });
  const result = await runInContainer(INFO, ["false"], {}, spawn);
  assert.equal(result.code, 1);
});

// --- isContainerRunning ------------------------------------------------------
//
// Backs index.ts's cached-ContainerInfo invalidation (the cached-identity /
// refreshed-mounts race in pi-devcontainer-herdr-validation.md § The bug): one
// `docker inspect`, not a full `devcontainer up`.

test("isContainerRunning is true for a running container", async () => {
  const { spawn, calls } = makeSpawn({ stdout: "true\n", code: 0 });
  assert.equal(await isContainerRunning("abc123", spawn), true);
  assert.deepEqual(calls[0].args, [
    "inspect",
    "--format",
    "{{.State.Running}}",
    "abc123",
  ]);
});

test("isContainerRunning is false for a stopped container", async () => {
  const { spawn } = makeSpawn({ stdout: "false\n", code: 0 });
  assert.equal(await isContainerRunning("abc123", spawn), false);
});

test("isContainerRunning is false when the container no longer exists (rebuild removed it)", async () => {
  const { spawn } = makeSpawn({
    stderr: "Error: No such container: abc123",
    code: 1,
  });
  assert.equal(await isContainerRunning("abc123", spawn), false);
});

// --- getMounts -------------------------------------------------------------

test("getMounts returns core's mount table in host-read-core's shape", async () => {
  const mounts: ContainerMount[] = [
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
  const seen: string[] = [];
  const result = await getMounts("/host/proj", (folder) => {
    seen.push(folder);
    return Promise.resolve(mounts);
  });
  assert.deepEqual(seen, ["/host/proj"]);
  assert.deepEqual(result, mounts);
});

test("getMounts turns core's `null` (no container) into an empty table", async () => {
  assert.deepEqual(await getMounts("/host", () => Promise.resolve(null)), []);
});

test("getMounts rethrows a docker failure as DevcInfraError", async () => {
  // Core *throws* here (`spawn docker ENOENT`) where the old `devc mounts`
  // exited non-zero — read_host's mount barrier must never see that as "no
  // mounts".
  await assert.rejects(
    () =>
      getMounts(
        "/host",
        () => Promise.reject(new Error("spawn docker ENOENT")),
      ),
    (err: unknown) => {
      assert.ok(err instanceof DevcInfraError);
      assert.match(err.message, /spawn docker ENOENT/);
      return true;
    },
  );
});
