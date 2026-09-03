/**
 * `*Operations` implementations matching pi's exported operation interfaces,
 * each backed by `runInSandbox` (i.e. `sbx exec`). These are the seam pi's
 * `create*Tool({ operations })` factories plug into, so the built-in tools'
 * names, schemas, and output formatting are reused while the actual
 * filesystem / shell work happens inside the sandbox.
 *
 * Unlike `pi-extensions/devcontainer`, there is no container-path
 * translation step: `sbx` mounts the workspace at the same path as the
 * host, so every operation uses the `filePath` argument it receives
 * directly (see `../paths.ts` and the plan's Concept boundaries).
 *
 * Also exports `getMounts`, the one piece `pi-extension-host-read-core`'s
 * `read_host`/`list_host_docs` need supplied per-backend: sbx's mount table
 * is always the single, statically-known `{ source: hostCwd }` entry — no
 * `sbx` call required (see the Contract section of the plan).
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
import {
  type RunOptions,
  type RunResult,
  runInSandbox,
  type SandboxInfo,
} from "./sbx.ts";

const DEFAULT_GREP_LIMIT = 100;

/** A `runInSandbox` already bound to a sandbox name; injectable for tests. */
export type SandboxRun = (
  argv: string[],
  opts?: RunOptions,
) => Promise<RunResult>;

/** Default runner: `sbx exec -i <name> -- <argv…>`. */
export function boundRun(info: SandboxInfo): SandboxRun {
  return (argv, opts) => runInSandbox(info.name, argv, opts);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function createReadOperations(run: SandboxRun): ReadOperations {
  return {
    readFile: async (filePath) => {
      const result = await run(["cat", "--", filePath]);
      if (result.code !== 0) {
        throw new Error(
          `cat ${filePath} failed (exit ${result.code}): ${
            decode(result.stderr).trim()
          }`,
        );
      }
      return Buffer.from(result.stdout);
    },
    access: async (filePath) => {
      const result = await run(["test", "-e", filePath]);
      if (result.code !== 0) {
        throw new Error(`${filePath}: not accessible in sandbox`);
      }
    },
    detectImageMimeType: async (filePath) => {
      const ext = path.posix.extname(filePath).toLowerCase();
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return null;
    },
  };
}

export function createWriteOperations(run: SandboxRun): WriteOperations {
  return {
    writeFile: async (filePath, content) => {
      // `tee` writes stdin to the file; its stdout copy is collected but ignored.
      const result = await run(["tee", "--", filePath], { stdin: content });
      if (result.code !== 0) {
        throw new Error(
          `write ${filePath} failed (exit ${result.code}): ${
            decode(result.stderr).trim()
          }`,
        );
      }
    },
    mkdir: async (dirPath) => {
      const result = await run(["mkdir", "-p", "--", dirPath]);
      if (result.code !== 0) {
        throw new Error(
          `mkdir ${dirPath} failed (exit ${result.code}): ${
            decode(result.stderr).trim()
          }`,
        );
      }
    },
  };
}

export function createEditOperations(run: SandboxRun): EditOperations {
  const read = createReadOperations(run);
  const write = createWriteOperations(run);
  return {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: read.access,
  };
}

export function createLsOperations(run: SandboxRun): LsOperations {
  return {
    exists: async (filePath) => {
      const result = await run(["test", "-e", filePath]);
      return result.code === 0;
    },
    stat: async (filePath) => {
      const result = await run(["stat", "-c", "%F", "--", filePath]);
      if (result.code !== 0) throw new Error(`${filePath}: not found in sandbox`);
      const kind = decode(result.stdout).trim();
      return { isDirectory: () => kind === "directory" };
    },
    readdir: async (dirPath) => {
      const result = await run(["ls", "-1A", "--", dirPath]);
      if (result.code !== 0) {
        throw new Error(`ls ${dirPath} failed (exit ${result.code})`);
      }
      return decode(result.stdout).split("\n").filter((line) =>
        line.length > 0
      );
    },
  };
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
  if (pattern.includes("/")) {
    return (
      path.posix.matchesGlob(relativePath, pattern) ||
      path.posix.matchesGlob(relativePath, `**/${pattern}`)
    );
  }
  return path.posix.matchesGlob(path.posix.basename(relativePath), pattern);
}

export function createFindOperations(run: SandboxRun): FindOperations {
  return {
    exists: async (filePath) => {
      const result = await run(["test", "-e", filePath]);
      return result.code === 0;
    },
    glob: async (pattern, cwd, options) => {
      // `rg --files` lists files honouring .gitignore; paths are relative to
      // cwd. Assumes `rg` is present in the `shell` agent kit's default
      // image — unverified against a real `sbx` binary (see the plan's
      // Testing section); if it turns out missing, a fallback to
      // `find <cwd> -type f` would need to replace this.
      const result = await run(["rg", "--files"], { cwd });
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(`rg --files in ${cwd} failed (exit ${result.code})`);
      }
      const relatives = decode(result.stdout).split("\n").filter((l) =>
        l.length > 0
      );
      const out: string[] = [];
      for (const rel of relatives) {
        if (out.length >= options.limit) break;
        if (options.ignore.some((ig) => matchesToolGlob(rel, ig))) continue;
        if (matchesToolGlob(rel, pattern)) out.push(path.posix.join(cwd, rel));
      }
      return out;
    },
  };
}

export function createBashOperations(run: SandboxRun): BashOperations {
  return {
    // `env` (from pi's built-in bash tool) is deliberately ignored: it is
    // always sourced from *this* process's host environment (see pi's
    // `resolveSpawnContext`/`getShellEnv`), never from anything
    // sandbox-aware. Forwarding it as `sbx exec -e` would clobber the
    // sandbox's own environment (e.g. $HOME) with host values.
    exec: async (command, cwd, { onData, signal, timeout }) => {
      if (signal?.aborted) throw new Error("aborted");

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
        const result = await run(["bash", "-lc", command], {
          cwd,
          signal: controller.signal,
          onStdout: (chunk) => onData(Buffer.from(chunk)),
          onStderr: (chunk) => onData(Buffer.from(chunk)),
        });
        if (timedOut) throw new Error(`timeout:${timeout}`);
        if (signal?.aborted) throw new Error("aborted");
        return { exitCode: result.code };
      } catch (error) {
        if (timedOut) throw new Error(`timeout:${timeout}`);
        if (signal?.aborted) throw new Error("aborted");
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

/**
 * Grep is implemented as a custom executor (not `GrepOperations`) because
 * pi's grep runs ripgrep on the *host* filesystem — supplying
 * `GrepOperations` would not route the search into the sandbox. We run `rg`
 * inside the sandbox and reformat its output into pi's `path:line: text` /
 * `path-line- text` shape.
 *
 * Simpler than devcontainer's version: there's no `remoteWorkspaceFolder`
 * root to relativize against — `cwd` is just `hostCwd`, and `searchArg` is
 * `path.posix.relative(hostCwd, target) || "."`.
 */
export async function executeSandboxGrep(
  hostCwd: string,
  params: GrepToolInput,
  _signal: AbortSignal | undefined,
  run: SandboxRun,
): Promise<TextToolResult<GrepToolDetails>> {
  const requested = (params.path ?? ".").trim() || ".";
  const target = path.posix.isAbsolute(requested)
    ? requested
    : path.posix.resolve(hostCwd, requested);
  const searchArg = path.posix.relative(hostCwd, target) || ".";

  const contextLines = params.context && params.context > 0
    ? params.context
    : 0;
  const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);

  const argv = ["rg", "--line-number", "--no-heading", "--color=never"];
  if (params.ignoreCase) argv.push("-i");
  if (params.literal) argv.push("-F");
  if (contextLines > 0) argv.push("-C", String(contextLines));
  if (params.glob) argv.push("-g", params.glob);
  argv.push("-e", params.pattern, "--", searchArg);

  const result = await run(argv, { cwd: hostCwd });
  // rg exits 1 when there are no matches; higher codes are real errors.
  if (result.code > 1) {
    throw new Error(
      `rg failed (exit ${result.code}): ${decode(result.stderr).trim()}`,
    );
  }

  const rawLines = decode(result.stdout).split("\n");
  const outputLines: string[] = [];
  let matchCount = 0;
  let matchLimitReached = false;
  let linesTruncated = false;

  for (const raw of rawLines) {
    if (raw === "" || raw === "--") continue;
    if (matchCount >= effectiveLimit) {
      matchLimitReached = true;
      break;
    }
    // rg --no-heading: matches are `path:line:text`, context is `path-line-text`.
    const matchLine = /^(.*?):(\d+):(.*)$/.exec(raw);
    const contextLine = matchLine ? null : /^(.*?)-(\d+)-(.*)$/.exec(raw);
    const parsed = matchLine ?? contextLine;
    if (!parsed) continue;
    const isMatch = matchLine !== null;
    const [, file, lineNo, text] = parsed;
    const { text: shown, wasTruncated } = truncateLine(
      (text ?? "").replace(/\r/g, ""),
    );
    if (wasTruncated) linesTruncated = true;
    const sep = isMatch ? ":" : "-";
    outputLines.push(`${file}${sep}${lineNo}${sep} ${shown}`);
    if (isMatch) matchCount++;
  }

  if (matchCount === 0) {
    return {
      content: [{ type: "text", text: "No matches found" }],
      details: undefined,
    };
  }

  const truncation = truncateHead(outputLines.join("\n"), {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  const details: GrepToolDetails = {};
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
 * sbx mounts the workspace at the same path as the host — there is exactly
 * one mount source, and it's known statically, with no `sbx` call required.
 * This is *not* a simplification of some richer sbx mount table; it's the
 * whole table, by construction of how `sbx run` mounts a workspace (see the
 * plan's Concept boundaries — no `sbx ls --json` or other introspection is
 * needed here).
 */
export function getMounts(hostCwd: string): Promise<HostMount[]> {
  return Promise.resolve([
    { type: "bind", source: hostCwd, destination: hostCwd, rw: true },
  ]);
}
