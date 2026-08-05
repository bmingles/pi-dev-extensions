import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createListHostDocsTool,
  createReadHostTool,
  type HostMount,
  type HostReadFs,
  type ListHostDocsDeps,
  type ReadHostDeps,
} from "./host-read.ts";

// ---------------------------------------------------------------------------
// read_host
// ---------------------------------------------------------------------------

/** A fake HostReadFs: `links` are symlinks, `files` are readable byte blobs. */
function makeHostFs(opts: {
  links?: Record<string, string>;
  files?: Record<string, string>;
  existing?: string[];
  /** realpathSync overrides; defaults to identity for paths not listed. */
  realpaths?: Record<string, string>;
  /** readDir results, keyed by directory path. */
  dirs?: Record<string, Array<{ name: string; isDirectory: boolean }>>;
}): HostReadFs {
  const links = opts.links ?? {};
  const files = opts.files ?? {};
  const existing = new Set(opts.existing ?? []);
  const realpaths = opts.realpaths ?? {};
  const dirs = opts.dirs ?? {};
  return {
    lstat: (p) => ({ isSymbolicLink: () => Object.hasOwn(links, p) }),
    readlink: (p) => {
      if (!Object.hasOwn(links, p)) throw new Error(`not a symlink: ${p}`);
      return links[p];
    },
    realpathSync: (p) => realpaths[p] ?? p,
    existsSync: (p) => existing.has(p),
    readNoFollow: (p) => {
      if (!Object.hasOwn(files, p)) throw new Error(`ENOENT: ${p}`);
      return Buffer.from(files[p], "utf8");
    },
    readDir: (p) => {
      if (!Object.hasOwn(dirs, p)) throw new Error(`ENOENT: ${p}`);
      return dirs[p];
    },
  };
}

/** Minimal ExtensionContext stub exposing only what read_host touches. */
function makeCtx(
  opts: { hasUI?: boolean; approve?: boolean; onConfirm?: () => void },
) {
  return {
    hasUI: opts.hasUI ?? true,
    ui: {
      confirm: async (_title: string, _message: string) => {
        opts.onConfirm?.();
        return opts.approve ?? false;
      },
    },
  } as unknown as ExtensionContext;
}

const BIND: HostMount = {
  type: "bind",
  source: "/host/proj",
  destination: "/workspaces/proj",
  rw: true,
};

function textOf(result: { content: Array<{ type: string }> }): string {
  const first = result.content[0];
  assert.equal(first.type, "text");
  return (first as unknown as { text: string }).text;
}

interface ReadHostResult {
  content: Array<{ type: string }>;
  details: { canonical?: string; denied?: boolean; error?: string };
}

async function runReadHost(
  deps: ReadHostDeps,
  path: string,
  ctx: ExtensionContext,
): Promise<ReadHostResult> {
  const tool = createReadHostTool("/host/proj", deps);
  return (await tool.execute(
    "id",
    { path },
    undefined,
    undefined,
    ctx,
  )) as ReadHostResult;
}

test("read_host rejects a path inside a mount (Attack A) without prompting", async () => {
  let prompted = false;
  const deps: ReadHostDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({ existing: ["/host/proj"] }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runReadHost(
    deps,
    "/host/proj/secret",
    makeCtx({ approve: true, onConfirm: () => (prompted = true) }),
  );
  assert.equal(prompted, false, "must not prompt for an in-mount path");
  assert.match(textOf(result), /denied/);
  assert.match(textOf(result), /\/host\/proj/);
});

test("read_host rejects Attack B (transit through a mount) without prompting", async () => {
  let prompted = false;
  const deps: ReadHostDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj"],
      links: {
        "/home/u/notes": "/host/proj/leak",
        "/host/proj/leak": "/home/u/secret",
      },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runReadHost(
    deps,
    "/home/u/notes",
    makeCtx({ approve: true, onConfirm: () => (prompted = true) }),
  );
  assert.equal(prompted, false);
  assert.match(textOf(result), /denied/);
});

test("read_host reads the canonical file after user approval", async () => {
  const deps: ReadHostDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj"],
      files: { "/home/u/notes.txt": "hello host" },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runReadHost(
    deps,
    "/home/u/notes.txt",
    makeCtx({ approve: true }),
  );
  assert.equal(textOf(result), "hello host");
  assert.deepEqual(result.details, { canonical: "/home/u/notes.txt" });
});

test("read_host returns a denied result when the user declines", async () => {
  const deps: ReadHostDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj"],
      files: { "/home/u/notes.txt": "hello host" },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runReadHost(
    deps,
    "/home/u/notes.txt",
    makeCtx({ approve: false }),
  );
  assert.match(textOf(result), /denied by user/);
  assert.equal(result.details.denied, true);
});

test("read_host refuses without an interactive UI", async () => {
  const deps: ReadHostDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj"],
      files: { "/home/u/notes.txt": "x" },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runReadHost(
    deps,
    "/home/u/notes.txt",
    makeCtx({ hasUI: false }),
  );
  assert.match(textOf(result), /no UI/);
});

test("read_host follows a safe symlink outside all mounts and reads the target", async () => {
  const deps: ReadHostDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj"],
      links: { "/home/u/link": "/etc/motd" },
      files: { "/etc/motd": "welcome" },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runReadHost(
    deps,
    "/home/u/link",
    makeCtx({ approve: true }),
  );
  assert.equal(textOf(result), "welcome");
  assert.deepEqual(result.details, { canonical: "/etc/motd" });
});

test("read_host reads a .md file under the docs path without prompting", async () => {
  let prompted = false;
  const deps: ReadHostDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj"],
      files: { "/docs/guide.md": "# Guide" },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runReadHost(
    deps,
    "/docs/guide.md",
    makeCtx({ hasUI: false, onConfirm: () => (prompted = true) }),
  );
  assert.equal(
    prompted,
    false,
    "must not prompt for a doc under unpromptedDocsPath",
  );
  assert.equal(textOf(result), "# Guide");
  assert.deepEqual(result.details, { canonical: "/docs/guide.md" });
});

test("read_host still prompts for a non-.md file under the docs path", async () => {
  const deps: ReadHostDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj"],
      files: { "/docs/data.json": "{}" },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runReadHost(
    deps,
    "/docs/data.json",
    makeCtx({ hasUI: false }),
  );
  assert.match(textOf(result), /no UI/);
});

test("read_host still prompts for a .md file outside the docs path", async () => {
  const deps: ReadHostDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj"],
      files: { "/home/u/readme.md": "hi" },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runReadHost(
    deps,
    "/home/u/readme.md",
    makeCtx({ hasUI: false }),
  );
  assert.match(textOf(result), /no UI/);
});

test("read_host still prompts for a .md symlink under the docs path that points outside it", async () => {
  const deps: ReadHostDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj", "/docs"],
      links: { "/docs/evil.md": "/home/u/secret.md" },
      files: { "/home/u/secret.md": "top secret" },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runReadHost(
    deps,
    "/docs/evil.md",
    makeCtx({ hasUI: false }),
  );
  assert.match(textOf(result), /no UI/);
});

test("read_host still applies the mount barrier to a .md path under the docs path", async () => {
  const deps: ReadHostDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({ existing: ["/host/proj"] }),
    unpromptedDocsPath: "/host/proj",
  };
  const result = await runReadHost(
    deps,
    "/host/proj/secret.md",
    makeCtx({ hasUI: false }),
  );
  assert.match(textOf(result), /denied/);
});

test("read_host realpaths a symlinked docs install so the exception still fires when requesting the real path directly", async () => {
  // getDocsPath() can point through a symlink (e.g. a global-bin install);
  // unpromptedDocsPath is realpath'd once at tool-creation time so it doesn't
  // desync from the fully-resolved canonical paths resolveHostPath produces.
  let prompted = false;
  const deps: ReadHostDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj", "/opt/pi-link"],
      realpaths: { "/opt/pi-link": "/usr/lib/pi/docs" },
      files: { "/usr/lib/pi/docs/guide.md": "# Guide" },
    }),
    unpromptedDocsPath: "/opt/pi-link",
  };
  const result = await runReadHost(
    deps,
    "/usr/lib/pi/docs/guide.md",
    makeCtx({ hasUI: false, onConfirm: () => (prompted = true) }),
  );
  assert.equal(prompted, false, "must not prompt once docsPath is realpath'd");
  assert.equal(textOf(result), "# Guide");
});

test("read_host falls back to the as-given docs path when it doesn't exist", async () => {
  const deps: ReadHostDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj"], // "/docs" deliberately absent
      files: { "/docs/guide.md": "# Guide" },
    }),
    unpromptedDocsPath: "/docs",
  };
  let prompted = false;
  const result = await runReadHost(
    deps,
    "/docs/guide.md",
    makeCtx({ hasUI: false, onConfirm: () => (prompted = true) }),
  );
  // existsSync("/docs") is false, so realpathSync is never called and the
  // as-given path is used as-is — still matches here since it's an identity
  // fake fs, but exercises the fallback branch.
  assert.equal(prompted, false);
  assert.equal(textOf(result), "# Guide");
});

// ---------------------------------------------------------------------------
// list_host_docs
// ---------------------------------------------------------------------------

interface ListHostDocsResult {
  content: Array<{ type: string }>;
  details: { canonical?: string; error?: string };
}

async function runListHostDocs(
  deps: ListHostDocsDeps,
  path: string | undefined,
): Promise<ListHostDocsResult> {
  const tool = createListHostDocsTool("/host/proj", deps);
  return (await tool.execute(
    "id",
    { path },
    undefined,
    undefined,
    undefined as unknown as ExtensionContext,
  )) as ListHostDocsResult;
}

test("list_host_docs lists the docs root with no path given", async () => {
  const deps: ListHostDocsDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj", "/docs"],
      dirs: {
        "/docs": [
          { name: "guide.md", isDirectory: false },
          { name: "assets", isDirectory: true },
        ],
      },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runListHostDocs(deps, undefined);
  assert.equal(textOf(result), "assets/\nguide.md");
  assert.deepEqual(result.details, { canonical: "/docs" });
});

test("list_host_docs lists a subdirectory under the docs root", async () => {
  const deps: ListHostDocsDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj", "/docs"],
      dirs: { "/docs/assets": [{ name: "diagram.png", isDirectory: false }] },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runListHostDocs(deps, "/docs/assets");
  assert.equal(textOf(result), "diagram.png");
});

test("list_host_docs refuses a path outside the docs root", async () => {
  const deps: ListHostDocsDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({ existing: ["/host/proj", "/docs"] }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runListHostDocs(deps, "/home/u/secret");
  assert.match(textOf(result), /outside the docs directory/);
});

test("list_host_docs rejects escape via a symlink inside the docs root", async () => {
  const deps: ListHostDocsDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj", "/docs"],
      links: { "/docs/escape": "/home/u/secret" },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runListHostDocs(deps, "/docs/escape");
  assert.match(textOf(result), /outside the docs directory/);
});

test("list_host_docs still applies the mount barrier", async () => {
  const deps: ListHostDocsDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({ existing: ["/host/proj"] }),
    unpromptedDocsPath: "/host/proj",
  };
  const result = await runListHostDocs(deps, "/host/proj/docs");
  assert.match(textOf(result), /denied/);
});

test("list_host_docs reports an empty directory", async () => {
  const deps: ListHostDocsDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj", "/docs"],
      dirs: { "/docs": [] },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runListHostDocs(deps, undefined);
  assert.equal(textOf(result), "(empty)");
});

test("list_host_docs treats an empty path as omitted and lists the docs root", async () => {
  const deps: ListHostDocsDeps = {
    getMounts: async () => [BIND],
    fs: makeHostFs({
      existing: ["/host/proj", "/docs"],
      dirs: { "/docs": [{ name: "guide.md", isDirectory: false }] },
    }),
    unpromptedDocsPath: "/docs",
  };
  const result = await runListHostDocs(deps, "");
  assert.equal(textOf(result), "guide.md");
});

test("list_host_docs refuses if the final path becomes a symlink between resolution and read", async () => {
  // Simulates a last-instant TOCTOU race: resolveHostPath's own lstat call
  // (the 1st call for this path) reports a regular file so resolution
  // completes normally, but the finalStat race-guard's lstat call (the 2nd)
  // reports it turned into a symlink — mirroring what read_host's final
  // O_NOFOLLOW open protects against, for a tool with no NOFOLLOW-capable
  // readdir equivalent.
  let lstatCalls = 0;
  const fs: HostReadFs = {
    lstat: (p) => {
      if (p !== "/docs/sub") return { isSymbolicLink: () => false };
      lstatCalls++;
      return { isSymbolicLink: () => lstatCalls > 1 };
    },
    readlink: () => {
      throw new Error("not a symlink");
    },
    realpathSync: (p) => p,
    existsSync: (p) => p === "/host/proj" || p === "/docs",
    readNoFollow: () => {
      throw new Error("not used by list_host_docs");
    },
    readDir: () => {
      throw new Error("must not be reached: race guard should deny first");
    },
  };
  const deps: ListHostDocsDeps = {
    getMounts: async () => [BIND],
    fs,
    unpromptedDocsPath: "/docs",
  };
  const result = await runListHostDocs(deps, "/docs/sub");
  assert.match(textOf(result), /became a symlink/);
});
