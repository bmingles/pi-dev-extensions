import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunOptions, RunResult } from "./sbx.ts";
import {
  createBashOperations,
  createFindOperations,
  createLsOperations,
  createReadOperations,
  createWriteOperations,
  executeSandboxGrep,
  getMounts,
  type SandboxRun,
} from "./tools.ts";

const HOST = "/home/u/proj";

interface RunCall {
  argv: string[];
  opts: RunOptions | undefined;
}

/** An injectable SandboxRun that records argv + opts and returns a canned result. */
function makeRun(result: Partial<RunResult> = {}) {
  const calls: RunCall[] = [];
  const run: SandboxRun = (argv, opts) => {
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

test("read.readFile issues `cat -- <path>` directly (no translation) and returns bytes", async () => {
  const { run, calls } = makeRun({ stdout: enc("file body") });
  const ops = createReadOperations(run);
  const buf = await ops.readFile(`${HOST}/src/a.ts`);
  assert.deepEqual(calls[0].argv, ["cat", "--", `${HOST}/src/a.ts`]);
  assert.equal(buf.toString("utf8"), "file body");
});

test("read.access throws on non-zero exit", async () => {
  const { run, calls } = makeRun({ code: 1 });
  const ops = createReadOperations(run);
  await assert.rejects(() => ops.access(`${HOST}/missing.ts`));
  assert.deepEqual(calls[0].argv, ["test", "-e", `${HOST}/missing.ts`]);
});

test("write.writeFile issues `tee -- <path>` with content on stdin", async () => {
  const { run, calls } = makeRun({ code: 0 });
  const ops = createWriteOperations(run);
  await ops.writeFile(`${HOST}/out.txt`, "hello world");
  assert.deepEqual(calls[0].argv, ["tee", "--", `${HOST}/out.txt`]);
  assert.equal(calls[0].opts?.stdin, "hello world");
});

test("write.mkdir issues `mkdir -p -- <path>`", async () => {
  const { run, calls } = makeRun({ code: 0 });
  const ops = createWriteOperations(run);
  await ops.mkdir(`${HOST}/a/b/c`);
  assert.deepEqual(calls[0].argv, ["mkdir", "-p", "--", `${HOST}/a/b/c`]);
});

test("ls.stat issues `stat -c %F` and reports directory-ness", async () => {
  const { run, calls } = makeRun({ stdout: enc("directory\n") });
  const ops = createLsOperations(run);
  const stat = await ops.stat(`${HOST}/somedir`);
  assert.deepEqual(calls[0].argv, ["stat", "-c", "%F", "--", `${HOST}/somedir`]);
  assert.equal(stat.isDirectory(), true);
});

test("ls.readdir issues `ls -1A` and splits entries", async () => {
  const { run, calls } = makeRun({ stdout: enc("a.ts\nb.ts\n.hidden\n") });
  const ops = createLsOperations(run);
  const entries = await ops.readdir(HOST);
  assert.deepEqual(calls[0].argv, ["ls", "-1A", "--", HOST]);
  assert.deepEqual(entries, ["a.ts", "b.ts", ".hidden"]);
});

test("bash.exec issues `bash -lc <cmd>`, threads cwd, and never forwards host env", async () => {
  const { run, calls } = makeRun({ code: 0 });
  const ops = createBashOperations(run);
  const chunks: Buffer[] = [];
  // `env` here stands in for pi's host-sourced env (see bash.js's
  // resolveSpawnContext) — it must never reach `sbx exec`, so the sandbox
  // gets whatever standard `docker exec` sets up (e.g. its own $HOME).
  const result = await ops.exec("echo hi", `${HOST}/sub`, {
    onData: (d) => chunks.push(d),
    env: { FOO: "bar" },
  });
  assert.deepEqual(calls[0].argv, ["bash", "-lc", "echo hi"]);
  assert.equal(calls[0].opts?.cwd, `${HOST}/sub`);
  assert.equal(calls[0].opts?.env, undefined);
  assert.equal(result.exitCode, 0);
});

test("bash.exec rejects immediately when the signal is already aborted", async () => {
  const { run } = makeRun({ code: 0 });
  const ops = createBashOperations(run);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      ops.exec("echo hi", HOST, { onData: () => {}, signal: controller.signal }),
    /aborted/,
  );
});

test("bash.exec honors a timeout by aborting the run", async () => {
  const timedOutRun: SandboxRun = (_argv, opts) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => {
        reject(new Error("aborted by signal"));
      });
    });
  const ops = createBashOperations(timedOutRun);
  await assert.rejects(
    () =>
      ops.exec("sleep 10", HOST, { onData: () => {}, timeout: 0.01 }),
    /timeout:0\.01/,
  );
});

test("find.glob runs `rg --files` under the given cwd and filters by glob", async () => {
  const { run, calls } = makeRun({
    stdout: enc("src/a.ts\nsrc/b.js\nREADME.md\n"),
  });
  const ops = createFindOperations(run);
  const matches = await ops.glob("*.ts", HOST, { ignore: [], limit: 100 });
  assert.deepEqual(calls[0].argv, ["rg", "--files"]);
  assert.equal(calls[0].opts?.cwd, HOST);
  assert.deepEqual(matches, [`${HOST}/src/a.ts`]);
});

test("find.glob honours the ignore list", async () => {
  const { run } = makeRun({ stdout: enc("src/a.ts\nnode_modules/x.ts\n") });
  const ops = createFindOperations(run);
  const matches = await ops.glob("**/*.ts", HOST, {
    ignore: ["node_modules/**"],
    limit: 100,
  });
  assert.deepEqual(matches, [`${HOST}/src/a.ts`]);
});

test("grep runs sandbox `rg` with flags and reformats output", async () => {
  const { run, calls } = makeRun({
    stdout: enc("src/a.ts:3:const x = 1\nsrc/a.ts:7:const y = 2\n"),
    code: 0,
  });
  const result = await executeSandboxGrep(
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
  assert.equal(calls[0].opts?.cwd, HOST);
  // searchArg for the default path (".") is "." — no remoteWorkspaceFolder
  // to relativize against, unlike devcontainer.
  assert.equal(argv.at(-1), ".");
  const text = textOf(result);
  assert.match(text, /src\/a\.ts:3: const x = 1/);
  assert.match(text, /src\/a\.ts:7: const y = 2/);
});

test("grep returns 'No matches found' when rg exits 1 with no output", async () => {
  const { run } = makeRun({ code: 1 });
  const result = await executeSandboxGrep(
    HOST,
    { pattern: "zzz" },
    undefined,
    run,
  );
  assert.equal(textOf(result), "No matches found");
  assert.equal(result.details, undefined);
});

test("grep on a subdirectory relativizes searchArg against hostCwd", async () => {
  const { run, calls } = makeRun({ stdout: enc("a.ts:1:x\n") });
  await executeSandboxGrep(
    HOST,
    { pattern: "x", path: `${HOST}/sub` },
    undefined,
    run,
  );
  assert.equal(calls[0].argv.at(-1), "sub");
  assert.equal(calls[0].opts?.cwd, HOST);
});

test("getMounts always resolves to the single { source: hostCwd } bind entry", async () => {
  for (
    const hostCwd of [
      "/home/u/proj",
      "/workspaces/other-project",
      "/",
      "/a/b/c/d",
    ]
  ) {
    const mounts = await getMounts(hostCwd);
    assert.deepEqual(mounts, [
      { type: "bind", source: hostCwd, destination: hostCwd, rw: true },
    ]);
  }
});
