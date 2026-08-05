/**
 * `*Operations` implementations matching pi's exported operation interfaces,
 * each backed by `runInContainer` (i.e. `devc exec`). These are the seam pi's
 * `create*Tool({ operations })` factories plug into, so the built-in tools'
 * names, schemas, and output formatting are reused while the actual filesystem
 * / shell work happens inside the devcontainer.
 *
 * Every path a routed tool receives is interpreted as a *container* path via
 * `toContainerPath`.
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
import {
  type ContainerInfo,
  runInContainer,
  type RunOptions,
  type RunResult,
} from "./devc.ts";
import { toContainerPath } from "./paths.ts";

const DEFAULT_GREP_LIMIT = 100;

/** A `runInContainer` already bound to a host cwd; injectable for tests. */
export type ContainerRun = (
  argv: string[],
  opts?: RunOptions,
) => Promise<RunResult>;

/** Default runner: `devc exec <hostCwd> -- <argv…>`. */
export function boundRun(hostCwd: string): ContainerRun {
  return (argv, opts) => runInContainer(hostCwd, argv, opts);
}

function map(info: ContainerInfo, hostCwd: string, p: string): string {
  return toContainerPath(p, hostCwd, info.remoteWorkspaceFolder);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function createReadOperations(
  info: ContainerInfo,
  hostCwd: string,
  run: ContainerRun = boundRun(hostCwd),
): ReadOperations {
  return {
    readFile: async (filePath) => {
      const cp = map(info, hostCwd, filePath);
      const result = await run(["cat", "--", cp]);
      if (result.code !== 0) {
        throw new Error(
          `cat ${cp} failed (exit ${result.code}): ${
            decode(result.stderr).trim()
          }`,
        );
      }
      return Buffer.from(result.stdout);
    },
    access: async (filePath) => {
      const cp = map(info, hostCwd, filePath);
      const result = await run(["test", "-e", cp]);
      if (result.code !== 0) {
        throw new Error(`${cp}: not accessible in container`);
      }
    },
    detectImageMimeType: async (filePath) => {
      const ext = path.posix.extname(map(info, hostCwd, filePath))
        .toLowerCase();
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return null;
    },
  };
}

export function createWriteOperations(
  info: ContainerInfo,
  hostCwd: string,
  run: ContainerRun = boundRun(hostCwd),
): WriteOperations {
  return {
    writeFile: async (filePath, content) => {
      const cp = map(info, hostCwd, filePath);
      // `tee` writes stdin to the file; its stdout copy is collected but ignored.
      const result = await run(["tee", "--", cp], { stdin: content });
      if (result.code !== 0) {
        throw new Error(
          `write ${cp} failed (exit ${result.code}): ${
            decode(result.stderr).trim()
          }`,
        );
      }
    },
    mkdir: async (dirPath) => {
      const cp = map(info, hostCwd, dirPath);
      const result = await run(["mkdir", "-p", "--", cp]);
      if (result.code !== 0) {
        throw new Error(
          `mkdir ${cp} failed (exit ${result.code}): ${
            decode(result.stderr).trim()
          }`,
        );
      }
    },
  };
}

export function createEditOperations(
  info: ContainerInfo,
  hostCwd: string,
  run: ContainerRun = boundRun(hostCwd),
): EditOperations {
  const read = createReadOperations(info, hostCwd, run);
  const write = createWriteOperations(info, hostCwd, run);
  return {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: read.access,
  };
}

export function createLsOperations(
  info: ContainerInfo,
  hostCwd: string,
  run: ContainerRun = boundRun(hostCwd),
): LsOperations {
  return {
    exists: async (filePath) => {
      const cp = map(info, hostCwd, filePath);
      const result = await run(["test", "-e", cp]);
      return result.code === 0;
    },
    stat: async (filePath) => {
      const cp = map(info, hostCwd, filePath);
      const result = await run(["stat", "-c", "%F", "--", cp]);
      if (result.code !== 0) throw new Error(`${cp}: not found in container`);
      const kind = decode(result.stdout).trim();
      return { isDirectory: () => kind === "directory" };
    },
    readdir: async (dirPath) => {
      const cp = map(info, hostCwd, dirPath);
      const result = await run(["ls", "-1A", "--", cp]);
      if (result.code !== 0) {
        throw new Error(`ls ${cp} failed (exit ${result.code})`);
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

export function createFindOperations(
  info: ContainerInfo,
  hostCwd: string,
  run: ContainerRun = boundRun(hostCwd),
): FindOperations {
  return {
    exists: async (filePath) => {
      const cp = map(info, hostCwd, filePath);
      const result = await run(["test", "-e", cp]);
      return result.code === 0;
    },
    glob: async (pattern, cwd, options) => {
      const root = map(info, hostCwd, cwd);
      // `rg --files` lists files honouring .gitignore; paths are relative to cwd.
      const result = await run(["rg", "--files"], { cwd: root });
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(`rg --files in ${root} failed (exit ${result.code})`);
      }
      const relatives = decode(result.stdout).split("\n").filter((l) =>
        l.length > 0
      );
      const out: string[] = [];
      for (const rel of relatives) {
        if (out.length >= options.limit) break;
        if (options.ignore.some((ig) => matchesToolGlob(rel, ig))) continue;
        if (matchesToolGlob(rel, pattern)) out.push(path.posix.join(root, rel));
      }
      return out;
    },
  };
}

export function createBashOperations(
  info: ContainerInfo,
  hostCwd: string,
  run: ContainerRun = boundRun(hostCwd),
): BashOperations {
  return {
    // `env` (from pi's built-in bash tool) is deliberately ignored: it is always
    // sourced from *this* process's host environment (see pi's
    // `resolveSpawnContext`/`getShellEnv`), never from anything container-aware.
    // Forwarding it as `devc exec --env` would clobber the container's own
    // environment (e.g. $HOME) with host values. No `--env` flags means `devc
    // exec` gets whatever standard `docker exec` sets up for the container.
    exec: async (command, cwd, { onData, signal, timeout }) => {
      if (signal?.aborted) throw new Error("aborted");
      const containerCwd = map(info, hostCwd, cwd);

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
          cwd: containerCwd,
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
 * Grep is implemented as a custom executor (like gondolin) because pi's grep
 * runs ripgrep on the *host* filesystem — supplying `GrepOperations` would not
 * route the search into the container. We run `rg` inside the container and
 * reformat its output into pi's `path:line: text` / `path-line- text` shape.
 */
export async function executeContainerGrep(
  info: ContainerInfo,
  hostCwd: string,
  params: GrepToolInput,
  _signal?: AbortSignal,
  run: ContainerRun = boundRun(hostCwd),
): Promise<TextToolResult<GrepToolDetails>> {
  const containerPath = map(info, hostCwd, params.path ?? ".");
  const rwf = info.remoteWorkspaceFolder;
  let searchArg = ".";
  let cwd = rwf;
  if (containerPath === rwf) {
    searchArg = ".";
  } else if (containerPath.startsWith(`${rwf}/`)) {
    searchArg = path.posix.relative(rwf, containerPath);
  } else {
    searchArg = containerPath;
    cwd = "/";
  }

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

  const result = await run(argv, { cwd });
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

