/**
 * `read_host` / `list_host_docs` — the backend-agnostic half of the
 * devcontainer/sbx-style "read the HOST filesystem" escape hatch.
 *
 * Extracted from `pi-extensions/devcontainer/src/tools.ts` (Phase 27/28) so a
 * second consumer (`pi-extensions/sbx`, Phase 31) can reuse the exact same
 * tool machinery instead of duplicating it. The only backend-specific piece —
 * what a container/sandbox's mounts actually are — is injected via
 * `deps.getMounts`; everything else (the mount barrier via
 * `resolveHostPath`, the confirmation prompt, the `.md` docs exception, the
 * `O_NOFOLLOW` read, truncation) is unchanged from the original
 * implementation.
 */

import nodeFs from "node:fs";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type HostFs, isInside, resolveHostPath } from "./resolve-host.ts";

/**
 * One entry of a backend's mount table. Shape mirrors `devc mounts --json`'s
 * `ContainerMount` (devcontainer's own `HostMount`, Phase 26), but this type
 * has no dependency on `devc` or any other backend — every consumer supplies
 * its own `getMounts` returning this shape.
 */
export interface HostMount {
  type: "bind" | "volume";
  /** Host-side path (for volumes, the docker-managed `/var/lib/docker/...` dir). */
  source: string;
  /** Container/sandbox-side mount point. */
  destination: string;
  rw: boolean;
}

/**
 * The host-fs surface `read_host` needs: the per-hop `HostFs` (lstat/readlink)
 * plus `realpathSync`/`existsSync` for canonicalizing mount sources and a
 * final `O_NOFOLLOW` read. Injectable so the tool is testable without touching
 * the real filesystem.
 */
export interface HostReadFs extends HostFs {
  realpathSync(path: string): string;
  existsSync(path: string): boolean;
  /** Open with `O_NOFOLLOW` on the final component and read all bytes. */
  readNoFollow(path: string): Buffer;
  /** List a directory's immediate entries (name + directory-ness). */
  readDir(path: string): Array<{ name: string; isDirectory: boolean }>;
}

/** Default host-fs backed by `node:fs`. */
export const realHostReadFs: HostReadFs = {
  lstat: (p) => nodeFs.lstatSync(p),
  readlink: (p) => nodeFs.readlinkSync(p),
  realpathSync: (p) => nodeFs.realpathSync(p),
  existsSync: (p) => nodeFs.existsSync(p),
  readNoFollow: (p) => {
    const fd = nodeFs.openSync(
      p,
      nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW,
    );
    try {
      return nodeFs.readFileSync(fd);
    } finally {
      nodeFs.closeSync(fd);
    }
  },
  readDir: (p) =>
    nodeFs.readdirSync(p, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
    })),
};

/**
 * Realpath `raw` if it exists; otherwise return it unchanged. Shared by
 * `read_host`'s doc exception and `list_host_docs`' scoping so both agree on
 * the same canonical docs root — realpath'd once so a symlinked pi install
 * doesn't desync from the fully-resolved paths `resolveHostPath` produces.
 * Fails safe: if resolution fails, the raw path is used as-is, which can only
 * make the docs-scoped features under-match (fall back to prompting / denying
 * list access), never over-match.
 */
function resolveDocsRoot(fs: HostReadFs, raw: string): string {
  try {
    if (fs.existsSync(raw)) return fs.realpathSync(raw);
  } catch {
    // Keep the as-given path.
  }
  return raw;
}

/** Current container's mounts, realpath'd to real, existing source dirs. */
async function getMountSources(
  getMounts: (hostCwd: string) => Promise<HostMount[]>,
  fs: HostReadFs,
  hostCwd: string,
): Promise<{ ok: true; sources: string[] } | { ok: false; reason: string }> {
  let mounts: HostMount[];
  try {
    mounts = await getMounts(hostCwd);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const sources: string[] = [];
  for (const m of mounts) {
    try {
      if (fs.existsSync(m.source)) sources.push(fs.realpathSync(m.source));
    } catch {
      // A source that no longer resolves cannot be transited — skip it.
    }
  }
  return { ok: true, sources };
}

export interface ReadHostDeps {
  /** No default — every consumer must supply its own mount source(s). */
  getMounts: (hostCwd: string) => Promise<HostMount[]>;
  fs: HostReadFs;
  /**
   * Host directory whose `.md` files are read without a confirmation prompt
   * (pi's own shipped docs — static reference material, not user data).
   * Still subject to the mount barrier above; only the prompt is skipped.
   * Realpath'd once at tool-creation time (see `createReadHostTool`) so a
   * symlinked install doesn't desync from `resolveHostPath`'s canonical
   * output.
   */
  unpromptedDocsPath: string;
}

interface ReadHostDetails {
  canonical?: string;
  denied?: boolean;
  error?: string;
}

function textResult(text: string, details: ReadHostDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * `read_host` reads a file from the *host* filesystem (outside every container
 * mount), gated by a user confirmation that shows the canonical resolved path.
 *
 * Security: the requested path is canonicalized one hop at a time by
 * `resolveHostPath`, which rejects the instant resolution steps into a mount
 * source (direct or via a symlink) — so the container can never redirect a
 * `read_host` into container-writable space. Because `res.canonical` is, by
 * construction, outside every mount, the container cannot alter it between
 * check and read; the `O_NOFOLLOW` final open is belt-and-suspenders against a
 * non-container race and needs no re-verification loop.
 *
 * Exception: `.md` files under `deps.unpromptedDocsPath` (pi's own shipped
 * docs, `getDocsPath()`) skip the confirmation prompt — they're static
 * reference material installed alongside pi itself, not user data. The mount
 * barrier still applies unconditionally.
 */
export function createReadHostTool(
  hostCwd: string,
  deps: ReadHostDeps,
) {
  const docsRoot = resolveDocsRoot(deps.fs, deps.unpromptedDocsPath);

  return defineTool({
    name: "read_host",
    label: "Read Host File",
    description:
      "Read a file from the HOST filesystem (outside the devcontainer's mounts), " +
      "with user confirmation. Use this ONLY for host files deliberately kept out " +
      "of the container; any path inside the workspace or a mount is refused — use " +
      "`read` for those. Exception: `.md` files under pi's own docs directory " +
      "(getDocsPath()) are read without a prompt. Output is truncated to 50KB / " +
      "2000 lines.",
    promptSnippet:
      "Read a host file outside the container's mounts (prompts the user).",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute host path to read." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // 1. Current container's mounts → real, existing source directories.
      const mountResult = await getMountSources(
        deps.getMounts,
        deps.fs,
        hostCwd,
      );
      if (!mountResult.ok) {
        return textResult(
          `read_host: could not determine container mounts: ${mountResult.reason}`,
          { error: mountResult.reason },
        );
      }

      // 2. Per-hop canonicalization with the mount barrier.
      const res = resolveHostPath(params.path, mountResult.sources, deps.fs);
      if (!res.ok) {
        return textResult(`read_host denied: ${res.reason}`, {
          error: res.reason,
        });
      }

      // 3. Confirm with the user, showing the canonical resolved path — unless
      // this is a `.md` file under pi's own docs directory, which is exempt.
      const isUnpromptedDoc = res.canonical.endsWith(".md") &&
        isInside(res.canonical, docsRoot);
      if (!isUnpromptedDoc) {
        if (!ctx.hasUI) {
          return textResult(
            "read_host requires interactive confirmation, but no UI is available.",
            { denied: true, canonical: res.canonical },
          );
        }
        const approved = await ctx.ui.confirm(
          "Read host file?",
          `Allow reading this HOST file (outside the container)?\n\n${res.canonical}`,
        );
        if (!approved) {
          return textResult(`read_host denied by user: ${res.canonical}`, {
            denied: true,
            canonical: res.canonical,
          });
        }
      }

      // 4. O_NOFOLLOW read of the canonical (symlink-free, outside-mounts) path.
      let buf: Buffer;
      try {
        buf = deps.fs.readNoFollow(res.canonical);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return textResult(
          `read_host failed to read ${res.canonical}: ${reason}`,
          {
            error: reason,
            canonical: res.canonical,
          },
        );
      }

      const truncation = truncateHead(buf.toString("utf8"), {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });
      let text = truncation.content;
      if (truncation.truncated) {
        text +=
          `\n\n[read_host truncated: ${truncation.outputLines} of ${truncation.totalLines} lines` +
          ` (${formatSize(truncation.outputBytes)} of ${
            formatSize(truncation.totalBytes)
          })]`;
      }
      return textResult(text, { canonical: res.canonical });
    },
  });
}

export interface ListHostDocsDeps {
  getMounts: (hostCwd: string) => Promise<HostMount[]>;
  fs: HostReadFs;
  /** Same root `read_host`'s `.md` exception uses; see `ReadHostDeps`. */
  unpromptedDocsPath: string;
}

interface ListHostDocsDetails {
  canonical?: string;
  error?: string;
}

function listTextResult(text: string, details: ListHostDocsDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * `list_host_docs` lists a directory under pi's own docs root on the HOST,
 * with no confirmation prompt — the corresponding read (`read_host` on a
 * `.md` file under the same root) is already unprompted, so gating discovery
 * of filenames more strictly than reading their contents would just move the
 * friction, not add safety.
 *
 * Security posture mirrors `read_host`: the requested path is resolved one
 * hop at a time via `resolveHostPath` (mount barrier + symlink-safe), and the
 * resulting canonical path must land inside the (realpath'd) docs root or the
 * request is denied — never silently redirected to a broader unprompted
 * listing. Unlike `read_host`, there is no user-confirmation fallback for
 * out-of-scope paths: this tool only ever serves the docs root; use
 * `read_host` for anything else.
 */
export function createListHostDocsTool(
  hostCwd: string,
  deps: ListHostDocsDeps,
) {
  const docsRoot = resolveDocsRoot(deps.fs, deps.unpromptedDocsPath);

  return defineTool({
    name: "list_host_docs",
    label: "List Host Docs",
    description:
      "List a directory under pi's own docs directory on the HOST (outside " +
      "the devcontainer's mounts) — no confirmation prompt, since this is " +
      "static reference material shipped with pi itself, not user data. " +
      "Use `read_host` to read the `.md` files this returns (also " +
      "unprompted, for files under this same directory). Any path outside " +
      "the docs directory is refused — use `read_host` for other host paths.",
    promptSnippet: "List pi's host docs directory (no prompt).",
    parameters: Type.Object({
      path: Type.Optional(Type.String({
        description:
          "Absolute host path to a subdirectory of pi's docs directory. Omit to list the docs directory's root.",
      })),
    }),
    async execute(_id, params) {
      const mountResult = await getMountSources(
        deps.getMounts,
        deps.fs,
        hostCwd,
      );
      if (!mountResult.ok) {
        return listTextResult(
          `list_host_docs: could not determine container mounts: ${mountResult.reason}`,
          { error: mountResult.reason },
        );
      }

      const requested = params.path || docsRoot;
      const res = resolveHostPath(requested, mountResult.sources, deps.fs);
      if (!res.ok) {
        return listTextResult(`list_host_docs denied: ${res.reason}`, {
          error: res.reason,
        });
      }
      if (!isInside(res.canonical, docsRoot)) {
        return listTextResult(
          `list_host_docs denied: ${res.canonical} is outside the docs ` +
            `directory (${docsRoot}); use read_host for other host paths.`,
          { error: "outside docs directory", canonical: res.canonical },
        );
      }

      // Belt-and-suspenders against a non-container race, mirroring
      // read_host's final O_NOFOLLOW open: `res.canonical` was already
      // symlink-free at check-time (resolveHostPath only ever returns a
      // resolved, non-symlink path), but `readDir` below has no NOFOLLOW
      // equivalent, so re-check immediately before using it.
      let finalStat: { isSymbolicLink(): boolean };
      try {
        finalStat = deps.fs.lstat(res.canonical);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return listTextResult(
          `list_host_docs failed to stat ${res.canonical}: ${reason}`,
          { error: reason, canonical: res.canonical },
        );
      }
      if (finalStat.isSymbolicLink()) {
        return listTextResult(
          `list_host_docs denied: ${res.canonical} became a symlink`,
          { error: "symlink at read time", canonical: res.canonical },
        );
      }

      let entries: Array<{ name: string; isDirectory: boolean }>;
      try {
        entries = deps.fs.readDir(res.canonical);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return listTextResult(
          `list_host_docs failed to list ${res.canonical}: ${reason}`,
          { error: reason, canonical: res.canonical },
        );
      }

      const lines = entries
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => e.isDirectory ? `${e.name}/` : e.name);
      const text = lines.length > 0 ? lines.join("\n") : "(empty)";
      return listTextResult(text, { canonical: res.canonical });
    },
  });
}
