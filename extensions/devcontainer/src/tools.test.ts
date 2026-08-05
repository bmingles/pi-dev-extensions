import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContainerInfo, RunOptions, RunResult } from "./devc.ts";
import {
  type ContainerRun,
  createBashOperations,
  createFindOperations,
  createLsOperations,
  createReadOperations,
  createWriteOperations,
  executeContainerGrep,
} from "./tools.ts";

const INFO: ContainerInfo = {
  containerId: "cid",
  remoteUser: "vscode",
  remoteWorkspaceFolder: "/workspaces/proj",
  remoteEnv: {},
};
const HOST = "/home/u/proj";

interface RunCall {
  argv: string[];
  opts: RunOptions | undefined;
}

/** An injectable ContainerRun that records argv + opts and returns a canned result. */
function makeRun(result: Partial<RunResult> = {}) {
  const calls: RunCall[] = [];
  const run: ContainerRun = (argv, opts) => {
    calls.push({ argv, opts });
    return Promise.resolve({
      code: result.code ?? 0,
      stdout: result.stdout ?? new Uint8Array(),
      stderr: result.stderr ?? new Uint8Array(),
    });
  };
  return { run, calls };
}

const enc = (s: string) => new TextEncoder().encode(s);

function textOf(result: { content: Array<{ type: string }> }): string {
  const first = result.content[0];
  assert.equal(first.type, "text");
  return (first as unknown as { text: string }).text;
}

test("read.readFile issues `cat -- <containerPath>` and returns bytes", async () => {
  const { run, calls } = makeRun({ stdout: enc("file body") });
  const ops = createReadOperations(INFO, HOST, run);
  const buf = await ops.readFile("src/a.ts");
  assert.deepEqual(calls[0].argv, ["cat", "--", "/workspaces/proj/src/a.ts"]);
  assert.equal(buf.toString("utf8"), "file body");
});

test("read.access throws on non-zero exit", async () => {
  const { run, calls } = makeRun({ code: 1 });
  const ops = createReadOperations(INFO, HOST, run);
  await assert.rejects(() => ops.access("missing.ts"));
  assert.deepEqual(calls[0].argv, [
    "test",
    "-e",
    "/workspaces/proj/missing.ts",
  ]);
});

test("write.writeFile issues `tee -- <path>` with content on stdin", async () => {
  const { run, calls } = makeRun({ code: 0 });
  const ops = createWriteOperations(INFO, HOST, run);
  await ops.writeFile("out.txt", "hello world");
  assert.deepEqual(calls[0].argv, ["tee", "--", "/workspaces/proj/out.txt"]);
  assert.equal(calls[0].opts?.stdin, "hello world");
});

test("write.mkdir issues `mkdir -p -- <path>`", async () => {
  const { run, calls } = makeRun({ code: 0 });
  const ops = createWriteOperations(INFO, HOST, run);
  await ops.mkdir("a/b/c");
  assert.deepEqual(calls[0].argv, [
    "mkdir",
    "-p",
    "--",
    "/workspaces/proj/a/b/c",
  ]);
});

test("ls.stat issues `stat -c %F` and reports directory-ness", async () => {
  const { run, calls } = makeRun({ stdout: enc("directory\n") });
  const ops = createLsOperations(INFO, HOST, run);
  const stat = await ops.stat("somedir");
  assert.deepEqual(calls[0].argv, [
    "stat",
    "-c",
    "%F",
    "--",
    "/workspaces/proj/somedir",
  ]);
  assert.equal(stat.isDirectory(), true);
});

test("ls.readdir issues `ls -1A` and splits entries", async () => {
  const { run, calls } = makeRun({ stdout: enc("a.ts\nb.ts\n.hidden\n") });
  const ops = createLsOperations(INFO, HOST, run);
  const entries = await ops.readdir(".");
  assert.deepEqual(calls[0].argv, ["ls", "-1A", "--", "/workspaces/proj"]);
  assert.deepEqual(entries, ["a.ts", "b.ts", ".hidden"]);
});

test("bash.exec issues `bash -lc <cmd>`, threads cwd, and never forwards host env", async () => {
  const { run, calls } = makeRun({ code: 0 });
  const ops = createBashOperations(INFO, HOST, run);
  const chunks: Buffer[] = [];
  // `env` here stands in for pi's host-sourced env (see bash.js's
  // resolveSpawnContext) — it must never reach `devc exec`, so the container
  // gets whatever standard `docker exec` sets up (e.g. its own $HOME).
  const result = await ops.exec("echo hi", "sub", {
    onData: (d) => chunks.push(d),
    env: { FOO: "bar" },
  });
  assert.deepEqual(calls[0].argv, ["bash", "-lc", "echo hi"]);
  assert.equal(calls[0].opts?.cwd, "/workspaces/proj/sub");
  assert.equal(calls[0].opts?.env, undefined);
  assert.equal(result.exitCode, 0);
});

test("bash.exec rejects immediately when the signal is already aborted", async () => {
  const { run } = makeRun({ code: 0 });
  const ops = createBashOperations(INFO, HOST, run);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      ops.exec("echo hi", ".", { onData: () => {}, signal: controller.signal }),
    /aborted/,
  );
});

test("find.glob runs `rg --files` under the mapped cwd and filters by glob", async () => {
  const { run, calls } = makeRun({
    stdout: enc("src/a.ts\nsrc/b.js\nREADME.md\n"),
  });
  const ops = createFindOperations(INFO, HOST, run);
  const matches = await ops.glob("*.ts", ".", { ignore: [], limit: 100 });
  assert.deepEqual(calls[0].argv, ["rg", "--files"]);
  assert.equal(calls[0].opts?.cwd, "/workspaces/proj");
  assert.deepEqual(matches, ["/workspaces/proj/src/a.ts"]);
});

test("find.glob honours the ignore list", async () => {
  const { run } = makeRun({ stdout: enc("src/a.ts\nnode_modules/x.ts\n") });
  const ops = createFindOperations(INFO, HOST, run);
  const matches = await ops.glob("**/*.ts", ".", {
    ignore: ["node_modules/**"],
    limit: 100,
  });
  assert.deepEqual(matches, ["/workspaces/proj/src/a.ts"]);
});

test("grep runs container `rg` with flags and reformats output", async () => {
  const { run, calls } = makeRun({
    stdout: enc("src/a.ts:3:const x = 1\nsrc/a.ts:7:const y = 2\n"),
    code: 0,
  });
  const result = await executeContainerGrep(
    INFO,
    HOST,
    { pattern: "const", ignoreCase: true, literal: true },
    undefined,
    run,
  );
  const argv = calls[0].argv;
  assert.equal(argv[0], "rg");
  assert.ok(argv.includes("-i"), "passes -i for ignoreCase");
  assert.ok(argv.includes("-F"), "passes -F for literal");
  assert.ok(argv.includes("-e"), "uses -e for the pattern");
  assert.equal(calls[0].opts?.cwd, "/workspaces/proj");
  const text = textOf(result);
  assert.match(text, /src\/a\.ts:3: const x = 1/);
  assert.match(text, /src\/a\.ts:7: const y = 2/);
});

test("grep returns 'No matches found' when rg exits 1 with no output", async () => {
  const { run } = makeRun({ code: 1 });
  const result = await executeContainerGrep(
    INFO,
    HOST,
    { pattern: "zzz" },
    undefined,
    run,
  );
  assert.equal(textOf(result), "No matches found");
  assert.equal(result.details, undefined);
});
