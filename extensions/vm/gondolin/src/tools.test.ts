import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBashOperations,
  createFindOperations,
  createLsOperations,
  createReadOperations,
  createWriteOperations,
  executeGondolinGrep,
  getMounts,
  type VmExecOptions as VmExecOptionsIn,
  type VmExecProcess,
  type VmLike,
  type VmStat,
} from "./tools.ts";

const HOST = "/home/u/proj";
const GUEST_WORKSPACE = "/workspace";

/** A tiny in-memory guest filesystem, keyed by guest-absolute path. */
interface FakeFile {
  content: Buffer;
}

interface FakeVmOptions {
  files?: Record<string, string>;
  dirs?: string[];
}

/** Builds a fake `VmLike` over an in-memory tree — no real micro-VM needed. */
function makeFakeVm(opts: FakeVmOptions = {}) {
  const files = new Map<string, FakeFile>();
  for (const [p, content] of Object.entries(opts.files ?? {})) {
    files.set(p, { content: Buffer.from(content, "utf8") });
  }
  const dirs = new Set<string>(opts.dirs ?? []);
  // Every ancestor of every file/dir is implicitly a directory.
  const addAncestors = (p: string) => {
    let cur = p;
    while (cur !== "/" && cur.includes("/")) {
      cur = cur.slice(0, cur.lastIndexOf("/")) || "/";
      dirs.add(cur);
    }
  };
  for (const p of files.keys()) addAncestors(p);
  for (const d of [...dirs]) addAncestors(d);

  const execCalls: Array<{ argv: string[]; opts: VmExecOptionsIn | undefined }> = [];

  const vm: VmLike = {
    fs: {
      readFile: async (p) => {
        const f = files.get(p);
        if (!f) throw new Error(`ENOENT: ${p}`);
        return f.content;
      },
      writeFile: async (p, content) => {
        files.set(p, { content: Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8") });
        addAncestors(p);
      },
      mkdir: async (p) => {
        dirs.add(p);
        addAncestors(p);
      },
      access: async (p) => {
        if (!files.has(p) && !dirs.has(p)) throw new Error(`ENOENT: ${p}`);
      },
      stat: async (p) => {
        const isDir = dirs.has(p);
        if (!isDir && !files.has(p)) throw new Error(`ENOENT: ${p}`);
        return { isDirectory: () => isDir } as VmStat;
      },
      listDir: async (p) => {
        const prefix = p === "/" ? "/" : `${p}/`;
        const names = new Set<string>();
        for (const candidate of [...files.keys(), ...dirs]) {
          if (candidate === p || !candidate.startsWith(prefix)) continue;
          const rest = candidate.slice(prefix.length);
          const name = rest.split("/")[0];
          if (name) names.add(name);
        }
        return [...names].sort();
      },
    },
    exec: (argv, opts) => {
      execCalls.push({ argv, opts });
      const resultPromise = Promise.resolve({ exitCode: 0, stdout: "" });
      return {
        output: async function* () {},
        then: resultPromise.then.bind(resultPromise),
      } as unknown as VmExecProcess;
    },
  };

  return { vm, execCalls };
}

test("read.readFile maps to a guest path and returns file bytes", async () => {
  const { vm } = makeFakeVm({ files: { "/workspace/src/a.ts": "file body" } });
  const ops = createReadOperations(vm, HOST, GUEST_WORKSPACE);
  const buf = await ops.readFile("src/a.ts");
  assert.equal(buf.toString("utf8"), "file body");
});

test("read.access throws for a missing guest path", async () => {
  const { vm } = makeFakeVm();
  const ops = createReadOperations(vm, HOST, GUEST_WORKSPACE);
  await assert.rejects(() => ops.access("missing.ts"));
});

test("write.writeFile writes at the mapped guest path", async () => {
  const { vm } = makeFakeVm();
  const ops = createWriteOperations(vm, HOST, GUEST_WORKSPACE);
  await ops.writeFile("out.txt", "hello world");
  const read = createReadOperations(vm, HOST, GUEST_WORKSPACE);
  assert.equal((await read.readFile("out.txt")).toString("utf8"), "hello world");
});

test("write.mkdir creates the mapped guest directory", async () => {
  const { vm } = makeFakeVm();
  const ops = createWriteOperations(vm, HOST, GUEST_WORKSPACE);
  await ops.mkdir("a/b/c");
  const ls = createLsOperations(vm, HOST, GUEST_WORKSPACE);
  assert.equal((await ls.stat("a/b/c")).isDirectory(), true);
});

test("ls.stat reports directory-ness", async () => {
  const { vm } = makeFakeVm({ dirs: ["/workspace/somedir"] });
  const ops = createLsOperations(vm, HOST, GUEST_WORKSPACE);
  assert.equal((await ops.stat("somedir")).isDirectory(), true);
});

test("ls.readdir lists direct children", async () => {
  const { vm } = makeFakeVm({ files: { "/workspace/a.ts": "", "/workspace/b.ts": "" } });
  const ops = createLsOperations(vm, HOST, GUEST_WORKSPACE);
  assert.deepEqual(await ops.readdir("."), ["a.ts", "b.ts"]);
});

test("bash.exec issues shellPath -lc <cmd>, threads guest cwd, streams output", async () => {
  const { vm, execCalls } = makeFakeVm();
  const ops = createBashOperations(vm, HOST, GUEST_WORKSPACE, "/bin/bash");
  const chunks: Buffer[] = [];
  const result = await ops.exec("echo hi", "sub", {
    onData: (d) => chunks.push(d),
    env: { FOO: "bar" },
  });
  assert.deepEqual(execCalls[0].argv, ["/bin/bash", "-lc", "echo hi"]);
  assert.equal(execCalls[0].opts?.cwd, "/workspace/sub");
  assert.equal(result.exitCode, 0);
});

test("bash.exec rejects immediately when the signal is already aborted", async () => {
  const { vm } = makeFakeVm();
  const ops = createBashOperations(vm, HOST, GUEST_WORKSPACE, "/bin/sh");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => ops.exec("echo hi", ".", { onData: () => {}, signal: controller.signal }),
    /aborted/,
  );
});

test("find.glob walks the guest tree honouring pattern + ignore", async () => {
  const { vm } = makeFakeVm({
    files: {
      "/workspace/src/a.ts": "",
      "/workspace/src/b.js": "",
      "/workspace/node_modules/x.ts": "",
    },
  });
  const ops = createFindOperations(vm, HOST, GUEST_WORKSPACE);
  const matches = await ops.glob("*.ts", ".", { ignore: [], limit: 100 });
  assert.deepEqual(matches, ["/workspace/src/a.ts"]);
});

test("find.glob honours the ignore list", async () => {
  const { vm } = makeFakeVm({
    files: {
      "/workspace/src/a.ts": "",
      "/workspace/vendor/x.ts": "",
    },
  });
  const ops = createFindOperations(vm, HOST, GUEST_WORKSPACE);
  const matches = await ops.glob("**/*.ts", ".", { ignore: ["vendor/**"], limit: 100 });
  assert.deepEqual(matches, ["/workspace/src/a.ts"]);
});

test("grep walks guest files and reformats matches", async () => {
  const { vm } = makeFakeVm({
    files: { "/workspace/src/a.ts": "const x = 1\nconst y = 2\n" },
  });
  const result = await executeGondolinGrep(vm, HOST, GUEST_WORKSPACE, { pattern: "const" }, undefined);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /src\/a\.ts:1: const x = 1/);
  assert.match(text, /src\/a\.ts:2: const y = 2/);
});

test("grep returns 'No matches found' when nothing matches", async () => {
  const { vm } = makeFakeVm({ files: { "/workspace/a.ts": "hello\n" } });
  const result = await executeGondolinGrep(vm, HOST, GUEST_WORKSPACE, { pattern: "zzz" }, undefined);
  assert.equal((result.content[0] as { text: string }).text, "No matches found");
  assert.equal(result.details, undefined);
});

test("getMounts always resolves to the single { source: hostCwd } bind entry", async () => {
  const mounts = await getMounts(HOST, GUEST_WORKSPACE);
  assert.deepEqual(mounts, [{ type: "bind", source: HOST, destination: GUEST_WORKSPACE, rw: true }]);
});
