/**
 * pi sbx extension — routes pi's built-in filesystem/shell tools into a
 * Docker Sandboxes (`sbx`) sandbox. Same shape as `pi-extensions/devcontainer`
 * (Phase 27), but the isolation boundary is an `sbx` sandbox instead of a
 * devcontainer — see the Phase 31 plan's "Why a separate extension" section
 * for why this isn't a mode of that extension.
 *
 * Reads and writes reflect the sandbox filesystem. Because `sbx` mounts the
 * workspace at the same path as the host, no path translation is needed —
 * unlike devcontainer's `remoteWorkspaceFolder` remapping.
 *
 * Usage:
 *   cd /path/to/project
 *   pi -e /path/to/pi-extensions/sbx
 *
 * Requires the `sbx` binary on PATH.
 */

import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  getDocsPath,
} from "@earendil-works/pi-coding-agent";
import {
  createListHostDocsTool,
  createReadHostTool,
  realHostReadFs,
} from "pi-extension-host-read-core";
import { isHomeDirectory } from "./paths.ts";
import { type SandboxInfo, sbxUp } from "./sbx.ts";
import {
  boundRun,
  createBashOperations,
  createEditOperations,
  createFindOperations,
  createLsOperations,
  createReadOperations,
  createWriteOperations,
  executeSandboxGrep,
  getMounts,
} from "./tools.ts";

export default function (pi: ExtensionAPI) {
  // devcontainer and sbx both override the same 7 built-in tools + read_host/
  // list_host_docs; pi's registry silently lets the later-loaded extension's
  // registrations win (no error), so having both active at once is a silent,
  // confusing footgun, not a supported configuration. Detect it via a
  // process-wide marker — extensions load sequentially (pi awaits each
  // factory before starting the next), so whichever loads second reliably
  // observes the first's marker regardless of `-e`/settings.json order.
  const ROUTING_MARKER_KEY = "__pi_active_routing_extension__";
  const globals = globalThis as unknown as Record<string, string | undefined>;
  const otherRoutingExtension = globals[ROUTING_MARKER_KEY];
  if (otherRoutingExtension && otherRoutingExtension !== "sbx") {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(
        `pi-extensions/sbx and pi-extensions/${otherRoutingExtension} are ` +
          "both loaded. Only one may route tools at a time — the other's " +
          "tool registrations are silently overwritten. Disable one in " +
          'settings.json (see the root README\'s "Package Filtering" note).',
        "error",
      );
    });
  }
  globals[ROUTING_MARKER_KEY] = "sbx";

  // Captured once, at extension load, from pi's launch directory. sbx mounts
  // this exact path into the sandbox (identity mount — see paths.ts).
  const hostCwd = process.cwd();

  // Built-in tools instantiated against the host cwd, used only for their
  // name + schema when spreading into the overrides below.
  const localRead = createReadTool(hostCwd);
  const localWrite = createWriteTool(hostCwd);
  const localEdit = createEditTool(hostCwd);
  const localBash = createBashTool(hostCwd);
  const localGrep = createGrepTool(hostCwd);
  const localFind = createFindTool(hostCwd);
  const localLs = createLsTool(hostCwd);

  let info: SandboxInfo | undefined;
  let starting: Promise<SandboxInfo> | undefined;

  // Sticky decision on whether starting a sandbox rooted at `hostCwd` is
  // approved, cached for the rest of this pi process once resolved (either
  // way) so a decline/no-UI refusal isn't re-prompted on every tool call.
  let homeDirGate: "approved" | Error | undefined;

  /** Lazily `sbxUp` once, cache the SandboxInfo anchor, reuse thereafter. */
  async function ensureSandbox(ctx?: ExtensionContext): Promise<SandboxInfo> {
    if (info) return info;
    if (homeDirGate instanceof Error) throw homeDirGate;
    if (!starting) {
      // Everything below runs synchronously up to its first `await`, so
      // `starting` is assigned before control returns to any other caller —
      // concurrent `ensureSandbox` calls (e.g. parallel tool invocations)
      // can't both slip past the `!starting` check and each trigger their
      // own confirmation prompt.
      starting = (async () => {
        if (
          homeDirGate !== "approved" && isHomeDirectory(hostCwd, homedir())
        ) {
          if (!ctx?.hasUI) {
            homeDirGate = new Error(
              "sbx start requires confirmation to mount the home " +
                "directory as the workspace, but no UI is available.",
            );
            throw homeDirGate;
          }
          const approved = await ctx.ui.confirm(
            "Start sbx sandbox in home directory?",
            `${hostCwd} is your home directory. Starting the sandbox here ` +
              "will mount your ENTIRE home directory into the sandbox as " +
              "the workspace.\n\nContinue?",
          );
          if (!approved) {
            homeDirGate = new Error(
              "sbx start declined: refused to mount the home directory as " +
                "the workspace.",
            );
            throw homeDirGate;
          }
          homeDirGate = "approved";
        }

        ctx?.ui.setStatus(
          "sbx",
          ctx?.ui.theme.fg("warning", "sbx: starting"),
        );
        // Simple spinner animation for loading message
        const spinnerChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let spinnerIndex = 0;
        const animationInterval = setInterval(() => {
          spinnerIndex = (spinnerIndex + 1) % spinnerChars.length;
          ctx?.ui.setStatus(
            "sbx",
            ctx?.ui.theme.fg("warning", `sbx: ${spinnerChars[spinnerIndex]} starting`),
          );
        }, 120);
        try {
          const resolved = await sbxUp(hostCwd);
          info = resolved;
          ctx?.ui.setStatus(
            "sbx",
            `sbx: ${resolved.name} (${resolved.sandboxId.slice(0, 12)})`,
          );
          ctx?.ui.notify(
            `sbx sandbox ready. Tools routed into ${resolved.name}.`,
            "info",
          );
          return resolved;
        } finally {
          clearInterval(animationInterval);
        }
      })().finally(() => {
        starting = undefined;
      });
    }
    return starting;
  }

  /**
   * `ensureSandbox` for a tool's `execute`: never throws. A rejection
   * (declined/no-UI home-dir confirmation, or an sbx infra failure) becomes
   * a plain tool-result error message instead of an uncaught exception — the
   * model sees why the tool failed, and no raw stack trace reaches the
   * session.
   */
  async function ensureSandboxForTool(
    ctx?: ExtensionContext,
  ): Promise<
    { ok: true; info: SandboxInfo } | {
      ok: false;
      result: { content: { type: "text"; text: string }[]; details: undefined };
    }
  > {
    try {
      return { ok: true, info: await ensureSandbox(ctx) };
    } catch (err) {
      return {
        ok: false,
        result: {
          content: [{
            type: "text",
            text: `sbx sandbox unavailable: ${describeError(err)}`,
          }],
          details: undefined,
        },
      };
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    // ensureSandbox can reject (declined/no-UI home-dir confirmation, or an
    // sbx infra failure). Letting that propagate out of a session_start
    // handler dumps a raw stack trace into the session (pi's extension
    // runner renders uncaught handler errors that way) — surface it as a
    // plain notification instead.
    try {
      await ensureSandbox(ctx);
    } catch (err) {
      ctx.ui.notify(`sbx: ${describeError(err)}`, "error");
    }
  });

  // NOTE: no session_shutdown teardown. sbx sandboxes are user-managed
  // (`sbx stop` / `sbx rm`); the extension must not stop or remove one on
  // pi exit.

  pi.registerCommand("sbx", {
    description: "Show the routed sbx sandbox status",
    handler: async (_args, ctx) => {
      let active: SandboxInfo;
      try {
        active = await ensureSandbox(ctx);
      } catch (err) {
        ctx.ui.notify(`sbx: ${describeError(err)}`, "error");
        return;
      }
      // Workspace path is identical on host and sandbox (identity mount),
      // so there's only one path worth printing, unlike /devcontainer's
      // separate host/container lines.
      ctx.ui.notify(
        [
          `Sandbox name: ${active.name}`,
          `Sandbox ID: ${active.sandboxId}`,
          `Workspace: ${active.workspace}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureSandboxForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createReadTool(hostCwd, {
        operations: createReadOperations(boundRun(active.info)),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureSandboxForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createWriteTool(hostCwd, {
        operations: createWriteOperations(boundRun(active.info)),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureSandboxForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createEditTool(hostCwd, {
        operations: createEditOperations(boundRun(active.info)),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureSandboxForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createBashTool(hostCwd, {
        operations: createBashOperations(boundRun(active.info)),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureSandboxForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createLsTool(hostCwd, {
        operations: createLsOperations(boundRun(active.info)),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureSandboxForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createFindTool(hostCwd, {
        operations: createFindOperations(boundRun(active.info)),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const active = await ensureSandboxForTool(ctx);
      if (!active.ok) return active.result;
      return executeSandboxGrep(
        hostCwd,
        params,
        signal,
        boundRun(active.info),
      );
    },
  });

  // `read_host` is a NEW tool (not an override): the one escape hatch that
  // reads the HOST filesystem, gated by a per-hop symlink resolver + mount
  // barrier and a user confirmation. It is registered directly against the
  // host cwd; it does not need `ensureSandbox`, since it acts on the host
  // filesystem directly and only needs `hostCwd`, not a live sandbox. Both
  // tools' machinery lives in the shared `pi-extension-host-read-core`
  // package (Phase 30); `getMounts` (this extension's static single-mount
  // source, from `./tools.ts`) is the one sbx-specific piece, passed in
  // explicitly since the shared factories have no default backend to fall
  // back to.
  const hostReadDeps = {
    getMounts,
    fs: realHostReadFs,
    unpromptedDocsPath: getDocsPath(),
  };
  pi.registerTool(createReadHostTool(hostCwd, hostReadDeps));

  // `list_host_docs` is the discovery counterpart to read_host's docs
  // exception: unprompted directory listing, scoped to the same docs root.
  pi.registerTool(createListHostDocsTool(hostCwd, hostReadDeps));

  // `user_bash` (bare `!`) is deliberately NOT routed — it is user-invoked
  // and stays on the host as the user's own shell / escape hatch.

  // No `before_agent_start` system-prompt patch: since sbx mounts the
  // workspace at the same path as the host, the existing
  // "Current working directory: <hostCwd>" line pi already sets is already
  // accurate — there's nothing incorrect to replace, unlike devcontainer's
  // `remoteWorkspaceFolder` remapping.
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
