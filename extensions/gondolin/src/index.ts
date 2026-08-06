/**
 * pi gondolin extension — routes pi's built-in filesystem/shell tools into a
 * local gondolin micro-VM (`@earendil-works/gondolin`). Same shape as
 * `pi-extensions/devcontainer` / `pi-extensions/sbx`, but the isolation
 * boundary here is a per-session micro-VM rather than a long-lived
 * devcontainer or Docker Sandbox — this extension starts and tears down its
 * own VM, unlike those two, which route into infrastructure managed
 * externally (`devc` / `sbx`).
 *
 * Reads and writes reflect the *guest* filesystem: the host cwd is mounted
 * read/write at a fixed guest workspace root, so in-VM edits write through to
 * the host, while everything else in the guest stays isolated — with no
 * per-operation permission prompts.
 *
 * Usage:
 *   cd /path/to/project
 *   pi -e /path/to/pi-dev-extensions/extensions/gondolin
 *
 * Requires Node.js >= 23.6.0 (see `@earendil-works/gondolin`'s own engines
 * floor) and QEMU installed (e.g. `brew install qemu` on macOS).
 */

import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import { type GondolinImagePath, resolveImagePath } from "./config.ts";
import { isHomeDirectory } from "./paths.ts";
import {
  createBashOperations,
  createEditOperations,
  createFindOperations,
  createLsOperations,
  createReadOperations,
  createWriteOperations,
  executeGondolinGrep,
  getMounts,
} from "./tools.ts";
import { GUEST_WORKSPACE, type GondolinVm, probeShellPath, startVm } from "./vm.ts";

export default function (pi: ExtensionAPI) {
  // devcontainer, sbx, and gondolin all override the same 7 built-in tools +
  // read_host/list_host_docs; pi's registry silently lets the later-loaded
  // extension's registrations win (no error), so having more than one active
  // at once is a silent, confusing footgun, not a supported configuration.
  // Detect it via a process-wide marker — extensions load sequentially (pi
  // awaits each factory before starting the next), so whichever loads later
  // reliably observes the earlier ones' marker regardless of `-e`/settings.json
  // order.
  const ROUTING_MARKER_KEY = "__pi_active_routing_extension__";
  const globals = globalThis as unknown as Record<string, string | undefined>;
  const otherRoutingExtension = globals[ROUTING_MARKER_KEY];
  if (otherRoutingExtension && otherRoutingExtension !== "gondolin") {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(
        `pi-extensions/gondolin and pi-extensions/${otherRoutingExtension} ` +
          "are both loaded. Only one may route tools at a time — the other's " +
          "tool registrations are silently overwritten. Disable one in " +
          'settings.json (see the root README\'s "Package Filtering" note).',
        "error",
      );
    });
  }
  globals[ROUTING_MARKER_KEY] = "gondolin";

  // Captured once, at extension load, from pi's launch directory — this is
  // the directory mounted read/write at GUEST_WORKSPACE in the VM.
  const hostCwd = process.cwd();

  // Built-in tools instantiated against the host cwd, used only for their name +
  // schema when spreading into the overrides below.
  const localRead = createReadTool(hostCwd);
  const localWrite = createWriteTool(hostCwd);
  const localEdit = createEditTool(hostCwd);
  const localBash = createBashTool(hostCwd);
  const localGrep = createGrepTool(hostCwd);
  const localFind = createFindTool(hostCwd);
  const localLs = createLsTool(hostCwd);

  let vm: GondolinVm | undefined;
  let shellPath = "/bin/sh";
  let starting: Promise<GondolinVm> | undefined;
  // Resolved once VM start succeeds, so /gondolin can report which image is
  // in use (undefined means gondolin's own stock default).
  let resolvedImagePath: GondolinImagePath | undefined;

  // Sticky decision on whether starting a VM rooted at `hostCwd` is approved,
  // cached for the rest of this pi process once resolved (either way) so a
  // decline/no-UI refusal isn't re-prompted on every tool call.
  let homeDirGate: "approved" | Error | undefined;

  /** Lazily start the VM once, probe its shell, cache both, reuse thereafter. */
  async function ensureVm(ctx?: ExtensionContext): Promise<GondolinVm> {
    if (vm) return vm;
    if (homeDirGate instanceof Error) throw homeDirGate;
    if (!starting) {
      // Everything below runs synchronously up to its first `await`, so
      // `starting` is assigned before control returns to any other caller —
      // concurrent `ensureVm` calls (e.g. parallel tool invocations) can't
      // both slip past the `!starting` check and each trigger their own
      // confirmation prompt.
      starting = (async () => {
        if (homeDirGate !== "approved" && isHomeDirectory(hostCwd, homedir())) {
          if (!ctx?.hasUI) {
            homeDirGate = new Error(
              "gondolin start requires confirmation to mount the home " +
                "directory as the workspace, but no UI is available.",
            );
            throw homeDirGate;
          }
          const approved = await ctx.ui.confirm(
            "Start gondolin VM in home directory?",
            `${hostCwd} is your home directory. Starting the VM here will ` +
              "mount your ENTIRE home directory into it as the " +
              "workspace.\n\nContinue?",
          );
          if (!approved) {
            homeDirGate = new Error(
              "gondolin start declined: refused to mount the home directory " +
                "as the workspace.",
            );
            throw homeDirGate;
          }
          homeDirGate = "approved";
        }

        ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", `gondolin: starting ${GUEST_WORKSPACE}`));
        try {
          // Resolved here (inside the try) so a malformed .pi/gondolin.json
          // fails the start the same way a VM boot failure would, rather
          // than throwing from some earlier, differently-handled spot.
          const imagePath = resolveImagePath(hostCwd);
          const resolved = await startVm(hostCwd, { imagePath });
          vm = resolved;
          resolvedImagePath = imagePath;
          shellPath = await probeShellPath(resolved);
          ctx?.ui.setStatus(
            "gondolin",
            ctx.ui.theme.fg("accent", `gondolin: ${resolved.id.slice(0, 8)} (${GUEST_WORKSPACE})`),
          );
          const imageNote = imagePath ? ` using image ${describeImagePath(imagePath)}` : "";
          ctx?.ui.notify(`Gondolin VM ready${imageNote}. ${hostCwd} is mounted at ${GUEST_WORKSPACE}.`, "info");
          return resolved;
        } catch (err) {
          ctx?.ui.setStatus("gondolin", undefined);
          throw err;
        }
      })().finally(() => {
        starting = undefined;
      });
    }
    return starting;
  }

  /**
   * `ensureVm` for a tool's `execute`: never throws. A rejection
   * (declined/no-UI home-dir confirmation, or a VM start failure) becomes a
   * plain tool-result error message instead of an uncaught exception — the
   * model sees why the tool failed, and no raw stack trace reaches the
   * session.
   */
  async function ensureVmForTool(
    ctx?: ExtensionContext,
  ): Promise<
    { ok: true; vm: GondolinVm } | {
      ok: false;
      result: { content: { type: "text"; text: string }[]; details: undefined };
    }
  > {
    try {
      return { ok: true, vm: await ensureVm(ctx) };
    } catch (err) {
      return {
        ok: false,
        result: {
          content: [{ type: "text", text: `gondolin unavailable: ${describeError(err)}` }],
          details: undefined,
        },
      };
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    // ensureVm can reject (declined/no-UI home-dir confirmation, or a VM
    // start failure). Letting that propagate out of a session_start handler
    // dumps a raw stack trace into the session (pi's extension runner
    // renders uncaught handler errors that way) — surface it as a plain
    // notification instead.
    try {
      await ensureVm(ctx);
    } catch (err) {
      ctx.ui.notify(`gondolin: ${describeError(err)}`, "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Unlike devcontainer/sbx's externally-managed containers/sandboxes, a
    // gondolin VM belongs entirely to this session — it must not outlive it.
    const activeVm = vm;
    vm = undefined;
    starting = undefined;
    resolvedImagePath = undefined;
    if (!activeVm) return;
    ctx.ui.setStatus("gondolin", ctx.ui.theme.fg("muted", "gondolin: stopping"));
    try {
      await activeVm.close();
    } finally {
      ctx.ui.setStatus("gondolin", undefined);
    }
  });

  pi.registerCommand("gondolin", {
    description: "Show the routed gondolin VM status",
    handler: async (_args, ctx) => {
      let active: GondolinVm;
      try {
        active = await ensureVm(ctx);
      } catch (err) {
        ctx.ui.notify(`gondolin: ${describeError(err)}`, "error");
        return;
      }
      ctx.ui.notify(
        [
          `VM: ${active.id}`,
          `Host workspace: ${hostCwd}`,
          `Guest workspace: ${GUEST_WORKSPACE}`,
          `Shell: ${shellPath}`,
          `Image: ${resolvedImagePath ? describeImagePath(resolvedImagePath) : "(gondolin default)"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureVmForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createReadTool(GUEST_WORKSPACE, {
        operations: createReadOperations(active.vm, hostCwd, GUEST_WORKSPACE),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureVmForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createWriteTool(GUEST_WORKSPACE, {
        operations: createWriteOperations(active.vm, hostCwd, GUEST_WORKSPACE),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureVmForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createEditTool(GUEST_WORKSPACE, {
        operations: createEditOperations(active.vm, hostCwd, GUEST_WORKSPACE),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureVmForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createBashTool(GUEST_WORKSPACE, {
        operations: createBashOperations(active.vm, hostCwd, GUEST_WORKSPACE, shellPath),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureVmForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createLsTool(GUEST_WORKSPACE, {
        operations: createLsOperations(active.vm, hostCwd, GUEST_WORKSPACE),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const active = await ensureVmForTool(ctx);
      if (!active.ok) return active.result;
      const tool = createFindTool(GUEST_WORKSPACE, {
        operations: createFindOperations(active.vm, hostCwd, GUEST_WORKSPACE),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const active = await ensureVmForTool(ctx);
      if (!active.ok) return active.result;
      return executeGondolinGrep(active.vm, hostCwd, GUEST_WORKSPACE, params, signal);
    },
  });

  // `read_host` is a NEW tool (not an override): the one escape hatch that reads
  // the HOST filesystem, gated by a per-hop symlink resolver + mount barrier and
  // a user confirmation. It is registered directly against the host cwd; it does
  // not need `ensureVm` — the VM's mount is a static, self-known fact (this
  // extension is the one that set it up), so `getMounts` needs no live VM to
  // query. Both tools' machinery lives in the shared
  // `pi-extension-host-read-core` package; `getMounts` is the one
  // gondolin-specific piece, passed in explicitly since the shared factories
  // have no default backend to fall back to.
  const hostReadDeps = {
    getMounts: (cwd: string) => getMounts(cwd, GUEST_WORKSPACE),
    fs: realHostReadFs,
    unpromptedDocsPath: getDocsPath(),
  };
  pi.registerTool(createReadHostTool(hostCwd, hostReadDeps));

  // `list_host_docs` is the discovery counterpart to read_host's docs
  // exception: unprompted directory listing, scoped to the same docs root.
  pi.registerTool(createListHostDocsTool(hostCwd, hostReadDeps));

  // `user_bash` (bare `!`) is deliberately NOT routed — it is user-invoked and
  // stays on the host as the user's own shell / escape hatch, matching
  // devcontainer/sbx (gondolin-reference routes it; this extension doesn't).

  pi.on("before_agent_start", async (event, ctx) => {
    let active: GondolinVm;
    try {
      active = await ensureVm(ctx);
    } catch {
      // session_start already surfaced this (or will, once a UI is
      // available) — stay silent here rather than notifying on every turn,
      // and leave the system prompt unmodified (still accurate: nothing is
      // routed into a VM that doesn't exist).
      return;
    }
    const localLine = `Current working directory: ${hostCwd}`;
    const guestLine =
      `Current working directory: ${GUEST_WORKSPACE} (gondolin VM ${active.id.slice(0, 8)}; host workspace mounted from ${hostCwd})`;
    const systemPrompt = event.systemPrompt.includes(localLine)
      ? event.systemPrompt.replace(localLine, guestLine)
      : `${event.systemPrompt}\n\n${guestLine}`;
    return { systemPrompt };
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Human-readable form of a resolved `GondolinImagePath` for status/notify text. */
function describeImagePath(imagePath: GondolinImagePath): string {
  return typeof imagePath === "string" ? imagePath : `${imagePath.rootfsPath} (explicit assets)`;
}
