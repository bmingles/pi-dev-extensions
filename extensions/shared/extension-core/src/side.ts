/**
 * The host/container side guard every loadable extension in this repo starts with.
 *
 * `pi-dev-extensions` splits its extensions by which side of the container boundary they
 * run on (see the repo root README's directory layout). Loading one on the wrong side used
 * to fail silently rather than loudly — `herdr-worktrees`' own mount guard, for instance, is
 * gated on `isContainer()` and simply does nothing when that's false, so a host load reports
 * success for paths it never checked. `requireSide` turns that into a hard, visible refusal:
 * an extension that cannot work on this side registers nothing at all.
 *
 * This deliberately differs from `devcontainer/src/index.ts`'s `ROUTING_MARKER_KEY` check,
 * which warns but lets both routing extensions carry on — that one is about two *valid*
 * extensions colliding, this one is about an extension that cannot function here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

export type Side = "host" | "container";

/** Injectable so the guard is testable without a container. */
export interface SideProbe {
  isContainer(): boolean;
}

/** `/.dockerenv` — the same signal `herdr-worktrees`' `realIsContainer` already uses.
 * Answers "am I in a container", not "am I in *the* devcontainer" — sufficient for this
 * guard, and not to be confused with `devcontainer`'s much stronger `ensureContainer`,
 * which resolves a *specific* container via `docker inspect`. */
export const realSideProbe: SideProbe = {
  isContainer: () => existsSync("/.dockerenv"),
};

export function detectSide(probe: SideProbe = realSideProbe): Side {
  return probe.isContainer() ? "container" : "host";
}

/**
 * True when the current side matches `expected`. When it does not, registers a
 * `session_start` notification naming the extension, the side it needs and the side it
 * found — and the caller must return immediately without registering anything else.
 */
export function requireSide(
  expected: Side,
  pi: ExtensionAPI,
  extensionName: string,
  probe: SideProbe = realSideProbe,
): boolean {
  const actual = detectSide(probe);
  if (actual === expected) return true;

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(
      `pi-extensions/${extensionName} requires the ${expected} side, but this ` +
        `process is running on the ${actual} side. Refusing to load — no tools ` +
        "registered.",
      "error",
    );
  });
  return false;
}
