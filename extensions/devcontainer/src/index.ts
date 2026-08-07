/**
 * pi devcontainer extension — routes pi's built-in filesystem/shell tools into a
 * devcontainer via the `devc` CLI (Phase 26). Same shape as pi's gondolin
 * reference extension, but the isolation boundary is a long-lived devcontainer
 * rather than a per-session micro-VM.
 *
 * Reads and writes reflect the *container* filesystem — the authoritative view
 * the agent should see (in-container edits, build output, volume-mounted paths
 * like node_modules the host can't see) — with no per-operation permission
 * prompts.
 *
 * Usage:
 *   cd /path/to/project
 *   pi -e /path/to/pi-extensions/devcontainer
 *
 * Requires the `devc` binary on PATH.
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
import {
  type ContainerInfo,
  devcUp,
  getMounts as devcGetMounts,
} from "./devc.ts";
import { isHomeDirectory } from "./paths.ts";
import {
  boundRun,
  createBashOperations,
  createEditOperations,
  createFindOperations,
  createLsOperations,
  createReadOperations,
  createWriteOperations,
  executeContainerGrep,
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
  if (otherRoutingExtension && otherRoutingExtension !== "devcontainer") {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(
        `pi-extensions/devcontainer and pi-extensions/${otherRoutingExtension} ` +
          "are both loaded. Only one may route tools at a time — the other's " +
          "tool registrations are silently overwritten. Disable one in " +
          'settings.json (see the root README\'s "Package Filtering" note).',
        "error",
      );
    });
  }
  globals[ROUTING_MARKER_KEY] = "devcontainer";

  // Captured once, at extension load, from pi's launch directory — the container
  // is resolved from it exactly as `devc attach` from that directory would.
  const hostCwd = process.cwd();
  const run = boundRun(hostCwd);

  // Built-in tools instantiated against the host cwd, used only for their name +
  // schema when spreading into the overrides below.
  const localRead = createReadTool(hostCwd);
  const localWrite = createWriteTool(hostCwd);
  const localEdit = createEditTool(hostCwd);
  const localBash = createBashTool(hostCwd);
  const localGrep = createGrepTool(hostCwd);
  const localFind = createFindTool(hostCwd);
  const localLs = createLsTool(hostCwd);

  let info: ContainerInfo | undefined;
  let starting: Promise<ContainerInfo> | undefined;

  // Sticky decision on whether starting a container rooted at `hostCwd` is
  // approved, cached for the rest of this pi process once resolved (either
  // way) so a decline/no-UI refusal isn't re-prompted on every tool call.
  let homeDirGate: "approved" | Error | undefined;

  /** Lazily `devc up` once, cache the ContainerInfo anchor, reuse thereafter. */
  async function ensureContainer(
    ctx?: ExtensionContext,
  ): Promise<ContainerInfo> {
    if (info) return info;
    if (homeDirGate instanceof Error) throw homeDirGate;
    if (!starting) {
      // Everything below runs synchronously up to its first `await`, so
      // `starting` is assigned before control returns to any other caller —
      // concurrent `ensureContainer` calls (e.g. parallel tool invocations)
      // can't both slip past the `!starting` check and each trigger their own
      // confirmation prompt.
      starting = (async () => {
        if (
          homeDirGate !== "approved" && isHomeDirectory(hostCwd, homedir())
        ) {
          if (!ctx?.hasUI) {
            homeDirGate = new Error(
              "devcontainer start requires confirmation to mount the home " +
                "directory as the workspace, but no UI is available.",
            );
            throw homeDirGate;
          }
          const approved = await ctx.ui.confirm(
            "Start devcontainer in home directory?",
            `${hostCwd} is your home directory. Starting the devcontainer ` +
              "here will mount your ENTIRE home directory into the " +
              "container as the workspace.\n\nContinue?",
          );
          if (!approved) {
            homeDirGate = new Error(
              "devcontainer start declined: refused to mount the home " +
                "directory as the workspace.",
            );
            throw homeDirGate;
          }
          homeDirGate = "approved";
        }

        ctx?.ui.setStatus(
          "devcontainer",
          ctx?.ui.theme.fg("warning", "devcontainer: starting"),
        );
        // Simple spinner animation for loading message
        const spinnerChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let spinnerIndex = 0;
        const animationInterval = setInterval(() => {
          spinnerIndex = (spinnerIndex + 1) % spinnerChars.length;
          ctx?.ui.setStatus(
            "devcontainer",
            ctx?.ui.theme.fg(
              "warning",
              `devcontainer: ${spinnerChars[spinnerIndex]} starting`,
            ),
          );
        }, 120);
        try {
          const resolved = await devcUp(hostCwd);
          info = resolved;
          ctx?.ui.setStatus(
            "devcontainer",
            `devcontainer: ${
              resolved.containerId.slice(0, 12)
            } (${resolved.remoteWorkspaceFolder})`,
          );
          ctx?.ui.notify(
            `devcontainer ready. Tools routed into ${resolved.remoteWorkspaceFolder}.`,
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
   * `ensureContainer` for a tool's `execute`: never throws. A rejection
   * (declined/no-UI home-dir confirmation, or a devc infra failure) becomes a
   * plain tool-result error message instead of an uncaught exception — the
   * model sees why the tool failed, and no raw stack trace reaches the
   * session.
   */
  async function ensureContainerForTool(
    ctx?: ExtensionContext,
  ): Promise<
    { ok: true; info: ContainerInfo } | {
      ok: false;
      result: { content: { type: "text"; text: string }[]; details: undefined };
    }
  > {
    try {
      return { ok: true, info: await ensureContainer(ctx) };
    } catch (err) {
      return {
        ok: false,
        result: {
          content: [{
            type: "text",
            text: `devcontainer unavailable: ${describeError(err)}`,
          }],
          details: undefined,
        },
      };
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    // ensureContainer can reject (declined/no-UI home-dir confirmation, or a
    // devc infra failure). Letting that propagate out of a session_start
    // handler dumps a raw stack trace into the session (pi's extension
    // runner renders uncaught handler errors that way) — surface it as a
    // plain notification instead.
    try {
      await ensureContainer(ctx);
    } catch (err) {
      ctx.ui.notify(`devcontainer: ${describeError(err)}`, "error");
    }
  });

  // NOTE: no session_shutdown teardown. devc containers are long-lived and
  // managed separately (`devc stop` / `devc down`); the extension must not
  // stop or remove the container on pi exit.

  pi.registerCommand("devcontainer", {
    description: "Show the routed devcontainer status",
    handler: async (_args, ctx) => {
      let active: ContainerInfo;
      try {
        active = await ensureContainer(ctx);
      } catch (err) {
        ctx.ui.notify(`devcontainer: ${describeError(err)}`, "error");
        return;
      }
      ctx.ui.notify(
        [
          `Container: ${active.containerId}`,
          `Remote user: ${active.remoteUser}`,
          `Host workspace: ${hostCwd}`,
          `Container workspace: ${active.remoteWorkspaceFolder}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureContainerForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createReadTool(active.info.remoteWorkspaceFolder, {
        operations: createReadOperations(active.info, hostCwd, run),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureContainerForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createWriteTool(active.info.remoteWorkspaceFolder, {
        operations: createWriteOperations(active.info, hostCwd, run),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureContainerForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createEditTool(active.info.remoteWorkspaceFolder, {
        operations: createEditOperations(active.info, hostCwd, run),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureContainerForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createBashTool(active.info.remoteWorkspaceFolder, {
        operations: createBashOperations(active.info, hostCwd, run),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureContainerForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createLsTool(active.info.remoteWorkspaceFolder, {
        operations: createLsOperations(active.info, hostCwd, run),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureContainerForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createFindTool(active.info.remoteWorkspaceFolder, {
        operations: createFindOperations(active.info, hostCwd, run),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const active = await ensureContainerForTool(ctx);
      if (!active.ok) return active.result;
      return executeContainerGrep(active.info, hostCwd, params, signal, run);
    },
  });

  // `read_host` is a NEW tool (not an override): the one escape hatch that reads
  // the HOST filesystem, gated by a per-hop symlink resolver + mount barrier and
  // a user confirmation. It is registered directly against the host cwd; it does
  // not need `ensureContainer`, but reads the current container's mounts to
  // exclude container-writable space. Both tools' machinery lives in the shared
  // `pi-extension-host-read-core` package (Phase 30); `getMounts` is the one
  // devcontainer-specific piece, passed in explicitly since the shared factories
  // have no default backend to fall back to.
  const hostReadDeps = {
    getMounts: devcGetMounts,
    fs: realHostReadFs,
    unpromptedDocsPath: getDocsPath(),
  };
  pi.registerTool(createReadHostTool(hostCwd, hostReadDeps));

  // `list_host_docs` is the discovery counterpart to read_host's docs
  // exception: unprompted directory listing, scoped to the same docs root.
  pi.registerTool(createListHostDocsTool(hostCwd, hostReadDeps));

  // `user_bash` fires for both `!` and `!!`. `!` is routed into the container
  // like the LLM's own `bash` tool — the two should behave identically. `!!`
  // (excludeFromContext, pi's own "don't show the model this" prefix) is the
  // deliberate escape hatch that stays on the host, unrouted.
  pi.on("user_bash", async (event, ctx) => {
    if (event.excludeFromContext) return;

    const active = await ensureContainerForTool(ctx);
    if (!active.ok) {
      return {
        result: {
          output: active.result.content.map((c) => c.text).join("\n"),
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    return { operations: createBashOperations(active.info, hostCwd, run) };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    let active: ContainerInfo;
    try {
      active = await ensureContainer(ctx);
    } catch {
      // session_start already surfaced this (or will, once a UI is
      // available) — stay silent here rather than notifying on every turn,
      // and leave the system prompt unmodified (still accurate: nothing is
      // routed into a container that doesn't exist).
      return;
    }
    const localLine = `Current working directory: ${hostCwd}`;
    const containerLine =
      `Current working directory: ${active.remoteWorkspaceFolder} (devcontainer via devc; host workspace ${hostCwd})`;
    const systemPrompt = event.systemPrompt.includes(localLine)
      ? event.systemPrompt.replace(localLine, containerLine)
      : `${event.systemPrompt}\n\n${containerLine}`;
    return { systemPrompt };
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
