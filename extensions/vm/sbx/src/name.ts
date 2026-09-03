/**
 * Deterministic, sbx-charset-safe sandbox naming.
 *
 * `sbx run --name <name>` only accepts letters, numbers, hyphens, periods,
 * plus and minus signs (see the plan's contract). A sandbox name derived from
 * `hostCwd` must therefore: sanitize the basename to that charset, stay
 * short, and disambiguate two different absolute paths that happen to share
 * a basename (a bare sanitized basename can't do that on its own) — done
 * here by appending a short stable hash of the *full*, resolved `hostCwd`.
 */

import { createHash } from "node:crypto";
import path from "node:path";

/** Prefix so sandboxes this extension creates are identifiable in `sbx ls`. */
const PREFIX = "pi-";

/** Hex chars of the SHA-256 digest of the full hostCwd appended to the name. */
const HASH_LEN = 8;

/**
 * Cap on the sanitized basename portion so the final name
 * (`pi-<basename>-<hash>`) stays well under any plausible `--name` length
 * limit (none is documented, so this is a conservative budget).
 */
const MAX_BASENAME_LEN = 40;

/** Fallback basename when sanitization strips everything (e.g. hostCwd is `/`). */
const FALLBACK_BASENAME = "sandbox";

/**
 * Lowercase, replace any run of characters outside `[a-z0-9.+-]` with a
 * single `-`, and trim leading/trailing `-`/`.` so the result never starts
 * or ends with a separator.
 */
function sanitizeBasename(raw: string): string {
  const lowered = raw.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9.+-]+/g, "-");
  const collapsed = replaced.replace(/-{2,}/g, "-");
  const trimmed = collapsed.replace(/^[-.]+/, "").replace(/[-.]+$/, "");
  return trimmed.length > 0 ? trimmed : FALLBACK_BASENAME;
}

/**
 * Deterministic sbx-charset-safe sandbox name for a given hostCwd. Stable
 * across processes (same hostCwd -> same name, every time); two different
 * absolute paths that happen to share a basename never collide, because the
 * appended hash is computed from the full, resolved path, not the basename.
 */
export function deriveSandboxName(hostCwd: string): string {
  const resolved = path.resolve(hostCwd);
  const base = sanitizeBasename(path.basename(resolved)).slice(
    0,
    MAX_BASENAME_LEN,
  );
  const hash = createHash("sha256").update(resolved).digest("hex").slice(
    0,
    HASH_LEN,
  );
  return `${PREFIX}${base}-${hash}`;
}
