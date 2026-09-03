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
