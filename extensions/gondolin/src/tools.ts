/**
 * `*Operations` implementations matching pi's exported operation interfaces,
 * each backed directly by the gondolin micro-VM's guest filesystem/exec API
 * (`VmLike`, a narrow structural slice of `@earendil-works/gondolin`'s real
 * `VM` — see `./vm.ts`). Unlike `pi-extensions/devcontainer` / `pi-extensions/
 * sbx`, there is no CLI spawn boundary to go through (`devc exec` / `sbx
 * exec`); every operation talks to the VM's own in-process API, ported from
 * `pi-extensions/gondolin-reference`'s inline implementation and split out
 * here so it's independently unit-testable against a fake `VmLike` instead of
 * a real micro-VM.
 *
 * Every path a routed tool receives is interpreted as a *guest* path via
 * `toGuestPath`.
 *
 * grep/find are implemented by walking the guest filesystem directly
 * (`fs.stat` / `fs.listDir` / `fs.readFile`) rather than shelling out to `rg`
 * like devcontainer/sbx do, because a fresh gondolin VM has no guaranteed
 * userspace beyond `/bin/sh` — the same choice `gondolin-reference` makes.
 */

import path from "node:path";
import {
  type BashOperations,
  DEFAULT_MAX_BYTES,
  type EditOperations,
  type FindOperations,
  formatSize,
  type GrepToolDetails,
  type GrepToolInput,
  type LsOperations,
  type ReadOperations,
  truncateHead,
  truncateLine,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { HostMount } from "pi-extension-host-read-core";
import { toGuestPath } from "./paths.ts";

const DEFAULT_GREP_LIMIT = 100;

/** Directory-ness result from `VmLike.fs.stat` (mirrors node's `fs.Stats`). */
export interface VmStat {
  isDirectory(): boolean;
}

/** What `await vm.exec(...)` resolves to in buffered mode (real: `ExecResult`). */
export interface VmExecResult {
  exitCode: number;
  stdout: string;
}

/**
 * A gondolin `vm.exec(...)` call: awaitable to a buffered `VmExecResult`, and
 * separately streamable via `.output()` when `stdout`/`stderr` are piped
 * (real: `ExecProcess`, which is both `PromiseLike<ExecResult>` and
 * `AsyncIterable`-via-`.output()`).
 */
export interface VmExecProcess extends PromiseLike<VmExecResult> {
  output(): AsyncIterable<{ data: Uint8Array }>;
}

export interface VmExecOptions {
  cwd?: string;
  signal?: AbortSignal;
  stdout?: "pipe";
  stderr?: "pipe";
}

/**
 * The subset of the real gondolin `VM`'s surface these operations need —
 * satisfied structurally by a real `VM` instance (see `./vm.ts`), and by a
 * lightweight fake in tests (no real micro-VM required).
 */
export interface VmLike {
  fs: {
    readFile(filePath: string): Promise<Buffer>;
    writeFile(
      filePath: string,
      data: string | Buffer,
      options?: { encoding?: string },
    ): Promise<void>;
    mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void>;
    access(filePath: string): Promise<void>;
    stat(filePath: string, options?: { signal?: AbortSignal }): Promise<VmStat>;
    listDir(dirPath: string, options?: { signal?: AbortSignal }): Promise<string[]>;
  };
  exec(command: string[], options?: VmExecOptions): VmExecProcess;
}

function map(hostCwd: string, guestWorkspace: string, p: string): string {
  return toGuestPath(p, hostCwd, guestWorkspace);
}

export function createReadOperations(
  vm: VmLike,
  hostCwd: string,
  guestWorkspace: string,
): ReadOperations {
  return {
    readFile: async (filePath) => vm.fs.readFile(map(hostCwd, guestWorkspace, filePath)),
    access: async (filePath) => {
      await vm.fs.access(map(hostCwd, guestWorkspace, filePath));
    },
    detectImageMimeType: async (filePath) => {
      const ext = path.posix.extname(map(hostCwd, guestWorkspace, filePath)).toLowerCase();
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return null;
    },
  };
}

export function createWriteOperations(
  vm: VmLike,
  hostCwd: string,
  guestWorkspace: string,
): WriteOperations {
  return {
    writeFile: async (filePath, content) => {
      await vm.fs.writeFile(map(hostCwd, guestWorkspace, filePath), content, { encoding: "utf8" });
    },
    mkdir: async (dirPath) => {
      await vm.fs.mkdir(map(hostCwd, guestWorkspace, dirPath), { recursive: true });
    },
  };
}

export function createEditOperations(
  vm: VmLike,
  hostCwd: string,
  guestWorkspace: string,
): EditOperations {
  const read = createReadOperations(vm, hostCwd, guestWorkspace);
  const write = createWriteOperations(vm, hostCwd, guestWorkspace);
  return { readFile: read.readFile, writeFile: write.writeFile, access: read.access };
}

export function createLsOperations(
  vm: VmLike,
  hostCwd: string,
  guestWorkspace: string,
): LsOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(map(hostCwd, guestWorkspace, filePath));
        return true;
      } catch {
        return false;
      }
    },
    stat: async (filePath) => vm.fs.stat(map(hostCwd, guestWorkspace, filePath)),
    readdir: async (dirPath) => vm.fs.listDir(map(hostCwd, guestWorkspace, dirPath)),
  };
}

async function walkGuestFiles(
  vm: VmLike,
  root: string,
  visit: (guestPath: string, relativePath: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const stat = await vm.fs.stat(root, { signal });
  if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

  const walkDirectory = async (dir: string, relativeDir: string): Promise<boolean> => {
    if (signal?.aborted) throw new Error("Operation aborted");
    const entries = await vm.fs.listDir(dir, { signal });
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const guestPath = path.posix.join(dir, entry);
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
      let entryStat: VmStat;
      try {
        entryStat = await vm.fs.stat(guestPath, { signal });
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        if (!(await walkDirectory(guestPath, relativePath))) return false;
      } else if (!(await visit(guestPath, relativePath))) {
        return false;
      }
    }
    return true;
  };

  return walkDirectory(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
  const normalizedPattern = pattern.split(path.sep).join(path.posix.sep);
  if (normalizedPattern.includes("/")) {
    return (
      path.posix.matchesGlob(relativePath, normalizedPattern) ||
      path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
    );
  }
  return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

export function createFindOperations(
  vm: VmLike,
  hostCwd: string,
  guestWorkspace: string,
): FindOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(map(hostCwd, guestWorkspace, filePath));
        return true;
      } catch {
        return false;
      }
    },
    glob: async (pattern, cwd, options) => {
      const root = map(hostCwd, guestWorkspace, cwd);
      const results: string[] = [];
      await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
        if (results.length >= options.limit) return false;
        if (options.ignore.some((ig) => matchesToolGlob(relativePath, ig))) return true;
        if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
        return results.length < options.limit;
      });
      return results;
    },
  };
}

export function createBashOperations(
  vm: VmLike,
  hostCwd: string,
  guestWorkspace: string,
  shellPath: string,
): BashOperations {
  return {
    // `env` (from pi's built-in bash tool) is deliberately ignored, matching
    // devcontainer/sbx: it is always sourced from *this* process's host
    // environment, never from anything guest-aware — forwarding it would
    // clobber the guest's own environment (e.g. $HOME) with host values.
    exec: async (command, cwd, { onData, signal, timeout }) => {
      if (signal?.aborted) throw new Error("aborted");
      const guestCwd = map(hostCwd, guestWorkspace, cwd);

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer = timeout && timeout > 0
        ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeout * 1000)
        : undefined;

      try {
        const proc = vm.exec([shellPath, "-lc", command], {
          cwd: guestCwd,
          signal: controller.signal,
          stdout: "pipe",
          stderr: "pipe",
        });
        for await (const chunk of proc.output()) onData(Buffer.from(chunk.data));
        const result = await proc;
        if (timedOut) throw new Error(`timeout:${timeout}`);
        if (signal?.aborted) throw new Error("aborted");
        return { exitCode: result.exitCode };
      } catch (error) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

type TextToolResult<TDetails> = {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails | undefined;
};

function createLineMatcher(
  pattern: string,
  literal: boolean | undefined,
  ignoreCase: boolean | undefined,
) {
  if (literal) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
  return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
  outputLines: string[];
  lines: string[];
  relativePath: string;
  lineIndex: number;
  contextLines: number;
}): boolean {
  let linesTruncated = false;
  const start = params.contextLines > 0 ? Math.max(0, params.lineIndex - params.contextLines) : params.lineIndex;
  const end = params.contextLines > 0
    ? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
    : params.lineIndex;

  for (let index = start; index <= end; index++) {
    const rawLine = params.lines[index] ?? "";
    const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
    if (wasTruncated) linesTruncated = true;
    const separator = index === params.lineIndex ? ":" : "-";
    params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
  }
  return linesTruncated;
}

/**
 * Grep is implemented as a custom executor (like `gondolin-reference`, and
 * like devcontainer/sbx's own grep) because pi's built-in grep runs ripgrep
 * on the *host* filesystem — supplying `GrepOperations` would not route the
 * search into the VM. Unlike devcontainer/sbx, this walks the guest
 * filesystem in JS rather than shelling out to `rg` inside the guest, since a
 * fresh gondolin image has no guaranteed `rg` binary.
 */
export async function executeGondolinGrep(
  vm: VmLike,
  hostCwd: string,
  guestWorkspace: string,
  params: GrepToolInput,
  signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
  const root = map(hostCwd, guestWorkspace, params.path ?? ".");
  const rootStat = await vm.fs.stat(root, { signal });
  const rootIsDirectory = rootStat.isDirectory();
  const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
  const contextLines = params.context && params.context > 0 ? params.context : 0;
  const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
  const outputLines: string[] = [];
  const details: GrepToolDetails = {};
  let matchCount = 0;
  let matchLimitReached = false;
  let linesTruncated = false;

  await walkGuestFiles(
    vm,
    root,
    async (guestPath, relativePath) => {
      if (matchCount >= effectiveLimit) return false;
      if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
      let content: Buffer;
      try {
        content = await vm.fs.readFile(guestPath);
      } catch {
        return true;
      }
      const lines = content
        .toString("utf8")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n");
      const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
      for (let index = 0; index < lines.length; index++) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (!matcher(lines[index] ?? "")) continue;
        matchCount++;
        if (appendGrepBlock({ outputLines, lines, relativePath: displayPath, lineIndex: index, contextLines })) {
          linesTruncated = true;
        }
        if (matchCount >= effectiveLimit) {
          matchLimitReached = true;
          return false;
        }
      }
      return true;
    },
    signal,
  );

  if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

  const rawOutput = outputLines.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  const notices: string[] = [];
  let output = truncation.content;

  if (matchLimitReached) {
    details.matchLimitReached = effectiveLimit;
    notices.push(`${effectiveLimit} matches limit reached`);
  }
  if (linesTruncated) {
    details.linesTruncated = true;
    notices.push("long lines truncated");
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

/**
 * gondolin mounts exactly one path — the host cwd, at `guestWorkspace` — and
 * that mount is set up by this extension itself (`./vm.ts`'s `startVm`), not
 * discovered from some external CLI. So, like `pi-extensions/sbx`'s static
 * `getMounts`, this is the *whole* mount table, known statically with no
 * async query required — not a simplification of a richer one.
 */
export function getMounts(hostCwd: string, guestWorkspace: string): Promise<HostMount[]> {
  return Promise.resolve([{ type: "bind", source: hostCwd, destination: guestWorkspace, rw: true }]);
}
