import assert from "node:assert/strict";
import { test } from "node:test";
import { type HostFs, isInside, resolveHostPath } from "./resolve-host.ts";

/**
 * A fake host filesystem: `links` maps a symlink path → its target. Anything not
 * in `links` is treated as a regular (non-symlink) file or directory whose mere
 * existence is not required (the resolver only calls `lstat` to test
 * symlink-ness). `readlink` throws for a non-symlink, matching real `fs`.
 */
function makeFs(links: Record<string, string> = {}): HostFs {
  return {
    lstat: (p) => ({ isSymbolicLink: () => Object.hasOwn(links, p) }),
    readlink: (p) => {
      if (!Object.hasOwn(links, p)) {
        throw new Error(`EINVAL: not a symlink: ${p}`);
      }
      return links[p];
    },
  };
}

test("normal path fully outside all mounts resolves to itself", () => {
  const res = resolveHostPath("/home/user/notes.txt", ["/work/src"], makeFs());
  assert.deepEqual(res, { ok: true, canonical: "/home/user/notes.txt" });
});

test("resolves correctly with multiple mount sources, none transited", () => {
  const res = resolveHostPath(
    "/home/user/docs/a.md",
    ["/work/src", "/var/lib/docker/volumes/v/_data"],
    makeFs(),
  );
  assert.deepEqual(res, { ok: true, canonical: "/home/user/docs/a.md" });
});

test("Attack A: requested path inside a mount is rejected", () => {
  const res = resolveHostPath("/work/src/leak", ["/work/src"], makeFs());
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /mount \/work\/src/);
});

test("requested path equal to a mount source is rejected", () => {
  const res = resolveHostPath("/work/src", ["/work/src"], makeFs());
  assert.equal(res.ok, false);
});

test("symlink inside a mount (pointing outside) is rejected at the mount boundary", () => {
  // The symlink lives under the mount; the first in-mount component trips the
  // barrier before the symlink is ever followed.
  const fs = makeFs({ "/work/src/leak": "/home/user/secret" });
  const res = resolveHostPath("/work/src/leak", ["/work/src"], fs);
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /mount \/work\/src/);
});

test("symlink located exactly at a mount source is rejected", () => {
  const fs = makeFs({ "/work/link": "/home/user/secret" });
  const res = resolveHostPath("/work/link", ["/work/link"], fs);
  assert.equal(res.ok, false);
});

test("Attack B: outside → into a mount → back outside is rejected on the transit", () => {
  // Both endpoints are outside all mounts, but resolution transits the
  // container-writable /work/src, so it must be rejected.
  const fs = makeFs({
    "/home/user/notes": "/work/src/leak2", // pre-existing host symlink into a mount
    "/work/src/leak2": "/home/user/secret", // container-written symlink back out
  });
  const res = resolveHostPath("/home/user/notes", ["/work/src"], fs);
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /mount \/work\/src/);
});

test("symlink loop (a → b → a) is rejected via the traversal cap", () => {
  const fs = makeFs({ "/a": "/b", "/b": "/a" });
  const res = resolveHostPath("/a", [], fs);
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /too many symbolic links/);
});

test("self-referential symlink (a → a) is rejected via the traversal cap", () => {
  const fs = makeFs({ "/loop": "/loop" });
  const res = resolveHostPath("/loop", [], fs);
  assert.equal(res.ok, false);
});

test(".. traversal normalizes correctly when outside all mounts", () => {
  const res = resolveHostPath("/home/user/../user/notes", [], makeFs());
  assert.deepEqual(res, { ok: true, canonical: "/home/user/notes" });
});

test(".. traversal is re-checked against the barrier", () => {
  // /safe/../work/secret normalizes into /work, a mount source.
  const res = resolveHostPath("/safe/../work/secret", ["/work"], makeFs());
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /mount \/work/);
});

test("absolute symlink target resolves from root", () => {
  const fs = makeFs({ "/home/user/link": "/etc/hosts" });
  const res = resolveHostPath("/home/user/link", ["/work"], fs);
  assert.deepEqual(res, { ok: true, canonical: "/etc/hosts" });
});

test("relative symlink target resolves against the link's directory", () => {
  const fs = makeFs({ "/home/user/link": "target.txt" });
  const res = resolveHostPath("/home/user/link", ["/work"], fs);
  assert.deepEqual(res, { ok: true, canonical: "/home/user/target.txt" });
});

test("relative symlink target with .. resolves correctly", () => {
  const fs = makeFs({ "/a/b/link": "../c/file" });
  const res = resolveHostPath("/a/b/link", [], fs);
  assert.deepEqual(res, { ok: true, canonical: "/a/c/file" });
});

test("a chain of safe symlinks resolves to the final target", () => {
  const fs = makeFs({
    "/home/user/a": "/home/user/b",
    "/home/user/b": "/home/user/c.txt",
  });
  const res = resolveHostPath("/home/user/a", ["/work"], fs);
  assert.deepEqual(res, { ok: true, canonical: "/home/user/c.txt" });
});

test("volume source is treated identically to a bind source", () => {
  const vol = "/var/lib/docker/volumes/proj_node_modules/_data";
  const res = resolveHostPath(`${vol}/x`, [vol], makeFs());
  assert.equal(res.ok, false);
  assert.match(
    (res as { reason: string }).reason,
    new RegExp(vol.replace(/\//g, "\\/")),
  );
});

test("Attack B variant: transit through a volume source is rejected", () => {
  const vol = "/var/lib/docker/volumes/v/_data";
  const fs = makeFs({
    "/home/user/notes": `${vol}/leak`,
    [`${vol}/leak`]: "/home/user/secret",
  });
  const res = resolveHostPath("/home/user/notes", [vol], fs);
  assert.equal(res.ok, false);
});

test("isInside: nested path is inside its root", () => {
  assert.equal(isInside("/a/b", "/a"), true);
});

test("isInside: sibling prefix is NOT inside (/ab not under /a)", () => {
  assert.equal(isInside("/ab", "/a"), false);
});

test("isInside: equal paths are inside", () => {
  assert.equal(isInside("/a", "/a"), true);
});

test("isInside: a root is not inside its own child", () => {
  assert.equal(isInside("/a", "/a/b"), false);
});

test("isInside: everything is inside root /", () => {
  assert.equal(isInside("/a/b/c", "/"), true);
});

test("isInside: trailing slashes are normalized", () => {
  assert.equal(isInside("/a/b/", "/a/"), true);
  assert.equal(isInside("/ab/", "/a/"), false);
});
