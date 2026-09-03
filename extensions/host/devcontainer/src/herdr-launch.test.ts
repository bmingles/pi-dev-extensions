import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  buildAgentCommandLine,
  commandForAgentKind,
  extractFirstPaneId,
  extractPaneId,
  paneSplitArgs,
  shellQuote,
} from "./herdr-launch.ts";

// ---- shellQuote -------------------------------------------------------------
// `pane run` types this line into the pane's shell, so every value that reaches it is a
// shell-injection surface. Branch names, labels and paths all do.

test("shellQuote wraps a plain value", () => {
  assert.equal(shellQuote("claude"), "'claude'");
});

test("shellQuote neutralizes spaces and metacharacters", () => {
  assert.equal(shellQuote("/a b/c&d;e"), "'/a b/c&d;e'");
  assert.equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
  assert.equal(shellQuote("`whoami`"), "'`whoami`'");
});

test("shellQuote escapes embedded single quotes", () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote("'"), "''\\'''");
});

test("shellQuote survives a quote-escape attempt", () => {
  // The classic break-out: close the quote, run a command, reopen.
  assert.equal(shellQuote("'; rm -rf /; '"), "''\\''; rm -rf /; '\\'''");
});

test("shellQuote handles an empty string", () => {
  assert.equal(shellQuote(""), "''");
});

// ---- commandForAgentKind ----------------------------------------------------

test("commandForAgentKind defaults to the kind itself", () => {
  assert.equal(commandForAgentKind("claude"), "claude");
  assert.equal(commandForAgentKind("codex"), "codex");
});

test("commandForAgentKind applies the two known exceptions", () => {
  assert.equal(commandForAgentKind("qodercli"), "qoder");
  assert.equal(commandForAgentKind("agy"), "antigravity");
});

// ---- buildAgentCommandLine --------------------------------------------------

const base = {
  agent: "claude",
  containerId: "abc123",
  remoteUser: "vscode",
  containerPath: "/workspaces/tools/x.worktrees/feat",
  command: "claude",
};

test("buildAgentCommandLine produces the verified recipe", () => {
  assert.equal(
    buildAgentCommandLine(base),
    "HERDR_AGENT='claude' docker exec -it -u 'vscode' " +
      "-w '/workspaces/tools/x.worktrees/feat' 'abc123' sh -lc 'exec '\\''claude'\\'''",
  );
});

test("buildAgentCommandLine keeps HERDR_AGENT a leading assignment, not an export", () => {
  const line = buildAgentCommandLine(base);
  assert.ok(line.startsWith("HERDR_AGENT="));
  assert.ok(!line.includes("export"));
  // It must ride the docker exec process — the pane's foreground process group.
  assert.ok(line.indexOf("HERDR_AGENT=") < line.indexOf("docker exec"));
});

test("buildAgentCommandLine runs a login shell and execs the agent", () => {
  // `docker exec` does not run a login shell, so ~/.local/bin is off PATH without `-l`;
  // `exec` keeps the agent as the foreground process rather than a child of a shell.
  assert.ok(buildAgentCommandLine(base).includes("sh -lc 'exec "));
});

test("buildAgentCommandLine appends and quotes agentArgs", () => {
  const line = buildAgentCommandLine({
    ...base,
    agentArgs: ["--permission-mode", "acceptEdits"],
  });
  assert.ok(
    line.endsWith(
      "sh -lc 'exec '\\''claude'\\'' '\\''--permission-mode'\\'' '\\''acceptEdits'\\'''",
    ),
    line,
  );
});

test("buildAgentCommandLine quotes each -e pair as one unit", () => {
  const line = buildAgentCommandLine({ ...base, env: { FOO: "a b", BAR: "x;y" } });
  assert.ok(line.includes("-e 'FOO=a b'"), line);
  assert.ok(line.includes("-e 'BAR=x;y'"), line);
});

/**
 * The strongest available assertion about quoting: hand the line to a real `sh` and read
 * back the words it splits into. A substring check cannot tell a neutralized `; id;` from a
 * live one — this can.
 */
function shellWords(line: string): string[] {
  const out = execFileSync("sh", ["-c", `printf '%s\\n' ${line}`], {
    encoding: "utf8",
  });
  return out.split("\n").slice(0, -1);
}

test("a real shell splits the line into exactly the intended argv", () => {
  assert.deepEqual(shellWords(buildAgentCommandLine(base)), [
    "HERDR_AGENT=claude",
    "docker",
    "exec",
    "-it",
    "-u",
    "vscode",
    "-w",
    "/workspaces/tools/x.worktrees/feat",
    "abc123",
    "sh",
    "-lc",
    "exec 'claude'",
  ]);
});

test("hostile values stay single words and start no new command", () => {
  const words = shellWords(buildAgentCommandLine({
    ...base,
    containerPath: "/w/it's a dir",
    command: "claude'; id; '",
    agentArgs: ["--flag=$(whoami)", "a b"],
    env: { FOO: "x;y" },
  }));
  assert.deepEqual(words, [
    "HERDR_AGENT=claude",
    "docker",
    "exec",
    "-it",
    "-u",
    "vscode",
    "-w",
    // One word, apostrophe and spaces intact — not three.
    "/w/it's a dir",
    "-e",
    "FOO=x;y",
    "abc123",
    "sh",
    "-lc",
    // The whole agent invocation is a single argument to `sh -lc`, and the injection
    // attempts survive as literal text rather than as syntax.
    "exec 'claude'\\''; id; '\\''' '--flag=$(whoami)' 'a b'",
  ]);
});

test("buildAgentCommandLine uses the container path, never a host one", () => {
  const line = buildAgentCommandLine({ ...base, containerPath: "/workspaces/x" });
  assert.ok(line.includes("-w '/workspaces/x'"));
});

// ---- paneSplitArgs ----------------------------------------------------------

test("paneSplitArgs passes the HOST path as --cwd, defaults to no-focus, and drops --json", () => {
  // No --json: verified live (0.8.2) that a sibling call in this same launch flow
  // (`pane run`) rejects it as an unrecognized option, while every response here is JSON
  // with or without it — see the comment on `paneSplitArgs`.
  assert.deepEqual(
    paneSplitArgs({ direction: "right", hostPath: "/Users/me/code/x", focus: false }),
    [
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--cwd",
      "/Users/me/code/x",
      "--no-focus",
    ],
  );
});

test("paneSplitArgs honors focus and direction", () => {
  const args = paneSplitArgs({ direction: "down", hostPath: "/h", focus: true });
  assert.ok(args.includes("--focus"));
  assert.ok(!args.includes("--no-focus"));
  assert.deepEqual(args.slice(3, 5), ["--direction", "down"]);
});

// ---- extractPaneId ----------------------------------------------------------

test("extractPaneId reads the nested and top-level spellings", () => {
  assert.equal(extractPaneId({ pane: { pane_id: "%3" } }), "%3");
  assert.equal(extractPaneId({ pane: { paneId: "%4" } }), "%4");
  assert.equal(extractPaneId({ pane: { id: "%5" } }), "%5");
  assert.equal(extractPaneId({ pane_id: "%6" }), "%6");
  assert.equal(extractPaneId({ paneId: "%7" }), "%7");
  assert.equal(extractPaneId({ id: "%8" }), "%8");
});

test("extractPaneId prefers the nested pane object", () => {
  assert.equal(extractPaneId({ id: "outer", pane: { id: "inner" } }), "inner");
});

test("extractPaneId returns undefined for junk", () => {
  assert.equal(extractPaneId(null), undefined);
  assert.equal(extractPaneId("nope"), undefined);
  assert.equal(extractPaneId({}), undefined);
  assert.equal(extractPaneId({ pane: {} }), undefined);
  assert.equal(extractPaneId({ pane_id: "" }), undefined);
  assert.equal(extractPaneId({ pane_id: 3 }), undefined);
});

// ---- extractFirstPaneId ------------------------------------------------------

test("extractFirstPaneId reads the first entry of a `panes` array", () => {
  assert.equal(
    extractFirstPaneId({ panes: [{ pane_id: "%1" }, { pane_id: "%2" }] }),
    "%1",
  );
  assert.equal(extractFirstPaneId({ panes: [{ paneId: "%3" }] }), "%3");
  assert.equal(extractFirstPaneId({ panes: [{ id: "%4" }] }), "%4");
});

test("extractFirstPaneId reads a bare array response", () => {
  assert.equal(extractFirstPaneId([{ id: "%5" }]), "%5");
});

test("extractFirstPaneId returns undefined for junk or an empty list", () => {
  assert.equal(extractFirstPaneId(null), undefined);
  assert.equal(extractFirstPaneId({}), undefined);
  assert.equal(extractFirstPaneId({ panes: [] }), undefined);
  assert.equal(extractFirstPaneId({ panes: [{}] }), undefined);
  assert.equal(extractFirstPaneId([]), undefined);
});
