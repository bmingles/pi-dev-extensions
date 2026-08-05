/**
 * pi caffeinate extension — runs macOS `caffeinate` on the host for exactly
 * the duration a pi agent run is active, so the Mac doesn't idle-sleep out
 * from under an unattended agent, with a footer status indicator showing
 * whether it's currently holding the machine awake.
 *
 * Usage:
 *   pi -e /path/to/pi-extensions/caffeinate
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type CaffeinateHandle,
  isSupportedPlatform,
  resolveArgs,
  startCaffeinate,
} from "./caffeinate.ts";

const STATUS_KEY = "caffeinate";
// Same braille spinner as the devcontainer extension's startup indicator —
// every frame is a single glyph, so the status text's width never changes
// (a growing "..." trailer would shift surrounding footer content each tick).
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ANIMATION_INTERVAL_MS = 120;

export default function (pi: ExtensionAPI) {
  let handle: CaffeinateHandle | undefined;
  let animation: ReturnType<typeof setInterval> | undefined;
  let unsupportedWarned = false;

  function stopAnimation() {
    if (animation) {
      clearInterval(animation);
      animation = undefined;
    }
  }

  function startAnimation(ctx: ExtensionContext) {
    stopAnimation();
    let frame = 0;
    const tick = () => {
      ctx.ui.setStatus(
        STATUS_KEY,
        ctx.ui.theme.fg(
          "warning",
          `caffeinate: ${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} awake`,
        ),
      );
      frame++;
    };
    tick();
    animation = setInterval(tick, ANIMATION_INTERVAL_MS);
  }

  function stop(ctx: ExtensionContext) {
    handle?.stop();
    handle = undefined;
    stopAnimation();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  function start(ctx: ExtensionContext) {
    // agent_start can fire again mid auto-retry/auto-compact without an
    // intervening agent_settled — only start once per unbroken run.
    if (handle) return;

    if (!isSupportedPlatform()) {
      if (!unsupportedWarned) {
        unsupportedWarned = true;
        ctx.ui.setStatus(
          STATUS_KEY,
          ctx.ui.theme.fg("dim", "caffeinate: unsupported (not macOS)"),
        );
      }
      return;
    }

    handle = startCaffeinate(resolveArgs(), undefined, (err) => {
      handle = undefined;
      stopAnimation();
      ctx.ui.setStatus(
        STATUS_KEY,
        ctx.ui.theme.fg("error", `caffeinate: failed (${err.message})`),
      );
    });
    startAnimation(ctx);
  }

  // `agent_start`/`agent_settled` bracket a full run (including any
  // auto-retry/auto-compact continuations) — `agent_end` alone fires too
  // early to be a reliable "the agent is done" signal.
  pi.on("agent_start", async (_event, ctx) => {
    start(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    stop(ctx);
  });

  // Defensive: make sure a live caffeinate process never outlives the
  // session it was started for.
  pi.on("session_shutdown", async (_event, ctx) => {
    stop(ctx);
  });

  pi.registerCommand("caffeinate", {
    description: "Show whether caffeinate is currently holding the Mac awake",
    handler: async (_args, ctx) => {
      if (!isSupportedPlatform()) {
        ctx.ui.notify(
          "caffeinate: unsupported on this platform (macOS only)",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        handle
          ? `caffeinate: active (pid ${handle.pid}, args: ${
            resolveArgs().join(" ")
          })`
          : "caffeinate: idle (no agent run in progress)",
        "info",
      );
    },
  });
}
