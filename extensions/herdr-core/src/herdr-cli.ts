/**
 * The one place in this package that shells out to the `herdr` binary.
 * Spawns it directly (`shell: false`), enforces a timeout, honors an
 * `AbortSignal`, and parses its JSON envelope into a uniform `Result<T>`.
 * Deliberately independent of `pi-herdr`'s own `herdr()` (see the package
 * README's "Not depend on `pi-herdr`" note) even though the shape is
 * intentionally similar — both wrap the same CLI, not each other.
 */

import { spawn } from "node:child_process";
import { resolveHerdrBin } from "./herdr-bin.ts";

export interface HerdrOk<T> {
  ok: true;
  data: T;
}
export interface HerdrErr {
  ok: false;
  message: string;
}
export type HerdrResult<T> = HerdrOk<T> | HerdrErr;

export interface RunHerdrOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** Parse the last JSON object in a possibly-mixed stdout buffer. */
function parseLastJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to a line scan
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep scanning
    }
  }
  return null;
}

/**
 * Run `herdr <args>`, parse its JSON envelope (`{"result": ...}` on success,
 * `{"error": {...}}` on failure), and return a `Result<T>`. Never throws —
 * every failure path resolves to `{ ok: false, message }`.
 */
export function runHerdr<T = unknown>(
  args: string[],
  opts: RunHerdrOpts = {},
): Promise<HerdrResult<T>> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const env = opts.env ?? process.env;
  return new Promise((resolve) => {
    const bin = resolveHerdrBin(env);
    let child;
    try {
      child = spawn(bin, args, { shell: false, env });
    } catch (e) {
      resolve({
        ok: false,
        message: `failed to spawn herdr ('${bin}'): ${msg(e)}`,
      });
      return;
    }

    let out = "";
    let stderr = "";
    let settled = false;

    const finish = (r: HerdrResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve(r);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish({
        ok: false,
        message: `herdr ${args.join(" ")} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish({ ok: false, message: `herdr ${args.join(" ")} aborted` });
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (d) => {
      out += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });

    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") {
        finish({
          ok: false,
          message:
            `herdr binary not found ('${bin}'). Set HERDR_BIN_PATH/HERDR_BIN ` +
            "or put herdr on PATH.",
        });
      } else {
        finish({ ok: false, message: `failed to run herdr: ${msg(e)}` });
      }
    });

    child.on("close", (exitCode) => {
      const parsed = parseLastJson(out);
      if (parsed && typeof parsed === "object") {
        const json = parsed as { error?: { message?: string }; result?: unknown };
        if (json.error) {
          finish({
            ok: false,
            message: json.error.message ?? "herdr reported an error",
          });
          return;
        }
        finish({ ok: true, data: (json.result ?? json) as T });
        return;
      }
      const firstErrLine = stderr.split(/\r?\n/).find((l) => l.trim());
      finish({
        ok: false,
        message: firstErrLine
          ? `herdr error: ${firstErrLine.trim()}`
          : `herdr ${args.join(" ")} exited ${exitCode} with no parseable output`,
      });
    });
  });
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
