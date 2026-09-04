/**
 * The command line a container agent is launched with, built as a *string* because that is
 * what `herdr pane run` takes: it types the line into the pane's shell. Everything here is
 * pure, and every interpolated value is shell-quoted, because a branch name, a label or a
 * path that reaches this string unquoted becomes arbitrary shell.
 *
 * The recipe itself is not ours to vary — see `devc-dev/docs/herdr-host-orchestrator.md`
 * § B3, where each element was measured:
 *
 *   HERDR_AGENT=<kind> docker exec -it -u <user> -w <containerPath> [-e K=V …] <id> \
 *     sh -lc 'exec <command> <args…>'
 *
 * - `HERDR_AGENT=<kind>` is a **leading assignment on the pane's command line**, never an
 *   export and never set inside the container. It rides the `docker exec` process, which is
 *   the pane's foreground process group, which is where Herdr reads it.
 * - `-it` — the agent needs a TTY.
 * - `sh -lc 'exec …'` — `docker exec` does not run a login shell, so `~/.local/bin` is off
 *   `PATH` and a bare `claude` fails; `exec` keeps the agent as the foreground process
 *   rather than a child of a shell.
 * - `-w <containerPath>` — the container path, never the host one.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Single-quote `value` for a posix shell, escaping embedded single quotes the only way a
 * single-quoted string can: close, escaped quote, reopen.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Herdr documents `--kind` as "supported agent kind **and canonical executable**", so the
 * executable for a kind is the kind itself. This is the minimal set of exceptions, taken
 * from the inverse of `devc/herdr.ts`'s `KIND_TABLE`.
 *
 * Deliberately not a full table: it would drift against Herdr's enum, and the
 * `command` parameter is the escape hatch for anything not covered, which costs nothing.
 */
const KIND_EXECUTABLE: Record<string, string> = {
  qodercli: "qoder",
  agy: "antigravity",
};

/** The container executable to run for a Herdr agent kind. */
export function commandForAgentKind(kind: string): string {
  return KIND_EXECUTABLE[kind] ?? kind;
}

export interface AgentCommandLineOpts {
  /** The Herdr agent kind, asserted via `HERDR_AGENT`. */
  agent: string;
  containerId: string;
  /** `docker exec -u`. */
  remoteUser: string;
  /** `docker exec -w`. A **container** path — translate before calling. */
  containerPath: string;
  /** The executable to run inside the container. */
  command: string;
  agentArgs?: string[];
  /** Extra `-e K=V` on the `docker exec`. */
  env?: Record<string, string>;
}

/** The single line handed to `herdr pane run`. */
export function buildAgentCommandLine(opts: AgentCommandLineOpts): string {
  const envFlags = Object.entries(opts.env ?? {}).flatMap((
    [key, value],
  ) => ["-e", shellQuote(`${key}=${value}`)]);
  // Quoted as one unit, so a key containing shell metacharacters is inert rather than
  // needing a validation rule of its own.
  const inner = [opts.command, ...(opts.agentArgs ?? [])]
    .map(shellQuote)
    .join(" ");
  return [
    `HERDR_AGENT=${shellQuote(opts.agent)}`,
    "docker",
    "exec",
    "-it",
    "-u",
    shellQuote(opts.remoteUser),
    "-w",
    shellQuote(opts.containerPath),
    ...envFlags,
    shellQuote(opts.containerId),
    "sh",
    "-lc",
    shellQuote(`exec ${inner}`),
  ].join(" ");
}

/**
 * `devc`'s dedicated agent subcommands ("devc-tools"' `devc/help.ts`, the authoritative
 * list) — keyed by the Herdr `--kind` value, valued by the `devc` subcommand name (currently
 * identical, kept as two things because that is a coincidence, not a promise). Deliberately
 * not the ~20-entry set `commandForAgentKind` covers: `devc attach` has no `EXTRA_ARGS` in
 * its own `--help`, so it cannot stand in for an arbitrary kind the way these three do — see
 * the plan's "Concept boundaries".
 */
const DEVC_SUBCOMMAND_FOR_KIND: Record<string, string> = {
  claude: "claude",
  copilot: "copilot",
  pi: "pi",
};

/**
 * `devc <kind> --cwd <containerPath> [<agentArgs…>]`, typed into the pane's own (host) shell
 * — the same shell the `docker` form's `docker exec` would be typed into — or `null` when
 * `kind` has no dedicated `devc` subcommand (only claude/copilot/pi do) or when `opts.env` is
 * non-empty. `devc claude`/`copilot`/`pi --help` (0.2.0, "devc-tools"' `devc/help.ts`) carry
 * no environment-variable flag, unlike the `docker` form's `-e K=V`, so there is no way to
 * honor a requested `env` here — returning `null` lets the caller fall back to the `docker`
 * builder instead of silently dropping it. Re-check `devc <kind> --help` before relaxing this
 * if a future `devc` release adds one.
 *
 * No `HERDR_AGENT=` prefix, no `sh -lc 'exec …'` wrapping: `devc <kind>` is already the
 * foreground command `devc`'s own watcher-plus-sidecar (`devc-tools`' `devc/herdr.ts`,
 * shipped separately, not part of this builder) watches for once it sees `HERDR_ENV` in the
 * pane — it asserts `HERDR_AGENT` on its own. `--cwd` takes `opts.containerPath` exactly as
 * the `docker` form's `-w` does: a **container** path, never the host one (`devc`'s `--cwd`
 * does accept a host path too and translates it, but this builder is never the place that
 * ambiguity should be introduced — the caller already resolved the container path).
 */
export function buildAgentCommandLineViaDevc(
  opts: AgentCommandLineOpts,
): string | null {
  const subcommand = DEVC_SUBCOMMAND_FOR_KIND[opts.agent];
  if (!subcommand) return null;
  if (opts.env && Object.keys(opts.env).length > 0) return null;

  return [
    "devc",
    subcommand,
    "--cwd",
    shellQuote(opts.containerPath),
    ...(opts.agentArgs ?? []).map(shellQuote),
  ].join(" ");
}

/**
 * Resolve a `devc` binary on `PATH` — the same synchronous `existsSync` walk
 * `pi-extension-herdr-core`'s `resolveHerdrBin` does for `herdr`, minus the env-var override:
 * `devc`'s presence only steers the *default* launcher choice (auto-detect), never a hard
 * requirement the way `HERDR_BIN_PATH` is for `herdr`, so `PATH` is the only signal worth
 * consulting. `env`/`exists` are injectable so this is testable with a fake `PATH` and no
 * real `devc` binary. Returns the resolved path, or `undefined` when nothing matched.
 */
export function resolveDevcBin(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const isWin = process.platform === "win32";
  const exts = isWin ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, ext ? `devc${ext}` : "devc");
      try {
        if (exists(candidate)) return candidate;
      } catch {
        // Unreadable directory on PATH — skip it.
      }
    }
  }
  return undefined;
}

/**
 * Auto-detect launcher strategy: the `devc` form when `devcBin` resolved *and* the kind is
 * covered (and `env` is empty), otherwise the `docker` form. This is what `index.ts` wires
 * into `HerdrToolDeps.buildCommandLine` for the auto-detect half of § Selection — the
 * explicit `launcher` override in `herdr-tools.ts`'s `execute` bypasses this entirely rather
 * than calling it, since an explicit request must error rather than silently substitute.
 */
export function buildAgentCommandLineAuto(
  devcBin: string | undefined,
  opts: AgentCommandLineOpts,
): string {
  if (devcBin !== undefined) {
    const viaDevc = buildAgentCommandLineViaDevc(opts);
    if (viaDevc !== null) return viaDevc;
  }
  return buildAgentCommandLine(opts);
}

export interface PaneSplitOpts {
  direction: "right" | "down";
  /** The pane's own shell cwd — the **host** path, which is what Herdr's Space and branch
   * display key off. Not the container path the agent runs in. */
  hostPath: string;
  focus: boolean;
}

/**
 * `herdr pane split --current --direction <dir> --cwd <hostPath> [--focus|--no-focus]`
 *
 * No `--json`: verified live (0.8.2) that `pane split`'s response is JSON with or without
 * the flag, and that some sibling `pane`/`agent` subcommands (`pane run`, `agent get`,
 * `agent rename` — see `herdr-tools.ts`) reject it outright as an unrecognized option. Since
 * it does nothing where it's accepted and breaks parsing where it isn't, it is dropped from
 * every call in this launcher rather than kept per-command.
 */
export function paneSplitArgs(opts: PaneSplitOpts): string[] {
  return [
    "pane",
    "split",
    "--current",
    "--direction",
    opts.direction,
    "--cwd",
    opts.hostPath,
    opts.focus ? "--focus" : "--no-focus",
  ];
}

function pickStr(
  o: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * Tolerantly pull a pane id out of a `pane split` response: `pane.pane_id` / `paneId` /
 * `id`, or the same keys at the top level. Same posture as `extractWorktree` in the shared
 * package — not an exhaustive schema, only enough to survive whichever shape comes back.
 */
export function extractPaneId(d: unknown): string | undefined {
  if (!d || typeof d !== "object") return undefined;
  const o = d as Record<string, unknown>;
  if (o.pane && typeof o.pane === "object") {
    const fromPane = pickStr(
      o.pane as Record<string, unknown>,
      "pane_id",
      "paneId",
      "id",
    );
    if (fromPane) return fromPane;
  }
  return pickStr(o, "pane_id", "paneId", "id");
}

/**
 * Tolerantly pull the first pane id out of a `pane list --workspace <id>` response — used to
 * retarget an already-open workspace (e.g. the one `worktree create` opens) instead of
 * splitting a new pane. `panes` array, or the response itself as an array; same key
 * variants as {@link extractPaneId}. Not exhaustive on the same grounds — `pane list`'s
 * shape has not been observed live, only its error envelope.
 */
export function extractFirstPaneId(d: unknown): string | undefined {
  const list = Array.isArray(d)
    ? d
    : d && typeof d === "object" && Array.isArray((d as Record<string, unknown>).panes)
    ? (d as Record<string, unknown>).panes as unknown[]
    : undefined;
  if (!list || list.length === 0) return undefined;
  const first = list[0];
  if (!first || typeof first !== "object") return undefined;
  return pickStr(first as Record<string, unknown>, "pane_id", "paneId", "id");
}
