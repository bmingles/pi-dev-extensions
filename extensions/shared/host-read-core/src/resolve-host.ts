/**
 * Per-hop host-path canonicalizer with a mount barrier.
 *
 * `read_host` (see `tools.ts`) is the one tool that reads the *host* filesystem.
 * Its security invariant: it must never return host content the container could
 * have influenced — i.e. anything under a mount source, reached directly **or
 * via a symlink**. Because the container can only write inside mount sources,
 * any container-controlled symlink lives inside a mount.
 *
 * A final-only `realpath` check is insufficient: `realpath` collapses the whole
 * chain, so it cannot see that resolution *passed through* a mount (see Attack B
 * in the phase plan). The fix is to canonicalize one component at a time,
 * following symlinks by hand, and reject the instant any resolved step lands
 * inside a mount source.
 *
 * Pure and fs-injectable so the attack/edge matrix runs against a fake fs.
 */

import path from "node:path";

export interface HostFs {
  lstat(path: string): { isSymbolicLink(): boolean };
  readlink(path: string): string;
}

export type ResolveResult =
  | { ok: true; canonical: string } // absolute, symlink-free, outside all mounts
  | { ok: false; reason: string };

/** Cap on total symlink traversals before we declare a loop. */
const MAX_LINKS = 40;

/** Normalize an absolute posix path, dropping any trailing slash (except root). */
function normalize(p: string): string {
  const n = path.posix.normalize(p);
  if (n.length > 1 && n.endsWith("/")) return n.slice(0, -1);
  return n;
}

/** true iff `p` equals `root` or is nested under it (both normalized absolute). */
export function isInside(p: string, root: string): boolean {
  const np = normalize(p);
  const nr = normalize(root);
  if (np === nr) return true;
  const prefix = nr === "/" ? "/" : `${nr}/`;
  return np.startsWith(prefix);
}

function isInsideAny(p: string, roots: string[]): string | undefined {
  for (const root of roots) {
    if (isInside(p, root)) return root;
  }
  return undefined;
}

/**
 * Canonicalize `requested` one component at a time, following symlinks by hand.
 * `mountSources` are host directories the container can write (already realpath'd
 * and normalized by the caller). At every resolved step — including each
 * intermediate symlink location and every component of a symlink target — reject
 * if it is inside any mountSource. Guards against symlink loops via a traversal
 * cap. Returns the fully-resolved canonical path (which, by construction, never
 * entered a mount) or a rejection.
 */
export function resolveHostPath(
  requested: string,
  mountSources: string[],
  fs: HostFs,
): ResolveResult {
  const sources = mountSources.map(normalize);

  let resolved = "/";
  const stack = requested.split("/");
  let links = 0;

  while (stack.length > 0) {
    const c = stack.shift() as string;
    if (c === "" || c === ".") continue;
    if (c === "..") {
      resolved = path.posix.dirname(resolved);
      continue;
    }

    const cand = path.posix.join(resolved, c);

    // Barrier: the moment a resolved step steps into a mount source, reject —
    // whether it is the final target, an intermediate dir, or a symlink itself.
    const hit = isInsideAny(cand, sources);
    if (hit) {
      return {
        ok: false,
        reason: `resolves into container-writable mount ${hit}`,
      };
    }

    let st: { isSymbolicLink(): boolean };
    try {
      st = fs.lstat(cand);
    } catch (err) {
      return {
        ok: false,
        reason: `cannot stat ${cand}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    if (st.isSymbolicLink()) {
      if (++links > MAX_LINKS) {
        return {
          ok: false,
          reason: `too many symbolic links (possible loop) at ${cand}`,
        };
      }
      let target: string;
      try {
        target = fs.readlink(cand);
      } catch (err) {
        return {
          ok: false,
          reason: `cannot readlink ${cand}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      const parts = target.split("/");
      if (path.posix.isAbsolute(target)) {
        // Absolute target: restart from root. resolved is intentionally NOT set
        // to `cand`, so the link's own location does not persist.
        resolved = "/";
      }
      // Relative target: resolve against the directory containing the link,
      // which is the current `resolved` (we never advanced it to `cand`).
      stack.unshift(...parts);
    } else {
      resolved = cand;
    }
  }

  return { ok: true, canonical: resolved };
}
