/**
 * Per-project gondolin image selection: which guest image `startVm` boots,
 * instead of gondolin's stock ~200MB default (`alpine-base:latest`). Lets a
 * project point at a custom image — e.g. one built via `gondolin build` with
 * `rootfsPackages: ["openjdk17-jdk", "gradle"]` baked in — so `bash`-routed
 * commands (a Gradle build, say) have the right toolchain available without
 * reinstalling it every session (a gondolin VM is otherwise torn down at
 * `session_shutdown` — see `../README.md`).
 *
 * Resolution order (first match wins):
 * 1. `$PI_GONDOLIN_IMAGE` — a machine-local override for ad hoc / not-yet-
 *    committed testing, mirroring `extensions/devcontainer`'s `$DEVC_BIN`.
 * 2. `.pi/gondolin.json`'s `imagePath` field, in the project (`hostCwd`) —
 *    committed to the repo so every session (and every teammate) gets the
 *    same environment automatically, the role `.devcontainer/
 *    devcontainer.json` plays for `extensions/devcontainer`.
 * 3. `undefined` — `startVm` omits `sandbox.imagePath` and gondolin boots its
 *    stock default image.
 *
 * `ImagePath`/`GuestAssets` aren't exported from `@earendil-works/gondolin`'s
 * package root (only reachable via `VMOptions["sandbox"]`'s type), so
 * `GondolinImagePath` below is a local, structurally-identical stand-in —
 * assigning it into `sandbox.imagePath` in `./vm.ts` still type-checks
 * against the real (unexported) type.
 */

import fs from "node:fs";
import path from "node:path";

export const CONFIG_RELATIVE_PATH = ".pi/gondolin.json";
export const IMAGE_ENV_VAR = "PI_GONDOLIN_IMAGE";

/** Mirrors gondolin's own (unexported) `ImagePath = string | GuestAssets`. */
export type GondolinImagePath =
  | string
  | { kernelPath: string; initrdPath: string; rootfsPath: string };

/** Injectable file reader so config resolution is testable without touching the real filesystem. */
export type ReadTextFile = (filePath: string) => string;

export interface ResolveImagePathDeps {
  env?: Record<string, string | undefined>;
  readFile?: ReadTextFile;
}

interface GondolinProjectConfig {
  imagePath?: GondolinImagePath;
}

const defaultReadFile: ReadTextFile = (p) => fs.readFileSync(p, "utf8");

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function isGuestAssetsShape(value: unknown): value is { kernelPath: string; initrdPath: string; rootfsPath: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.kernelPath === "string" && typeof v.initrdPath === "string" && typeof v.rootfsPath === "string";
}

/**
 * Parses `.pi/gondolin.json`'s `imagePath` field. Throws with a clear,
 * path-prefixed message on malformed JSON or an `imagePath` of the wrong
 * shape — a config file that *exists* but is broken should fail loudly
 * rather than silently falling back to the stock image.
 */
function parseConfig(text: string, configPath: string): GondolinProjectConfig {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${configPath}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(`${configPath}: expected a JSON object`);
  }
  const imagePath = (json as Record<string, unknown>).imagePath;
  if (imagePath === undefined) return {};
  if (typeof imagePath === "string" || isGuestAssetsShape(imagePath)) {
    return { imagePath };
  }
  throw new Error(
    `${configPath}: "imagePath" must be a string (image ref like "name:tag", a build id, or an asset ` +
      `directory path) or an object { kernelPath, initrdPath, rootfsPath }`,
  );
}

/**
 * Resolves the guest image `startVm` should boot for `hostCwd`, per the
 * precedence documented above. Returns `undefined` when neither the env var
 * nor the project config specify one — a missing config file is the normal,
 * common case (most projects don't need a custom image) and is not an
 * error; only a config file that *exists* but is malformed throws.
 */
export function resolveImagePath(
  hostCwd: string,
  deps: ResolveImagePathDeps = {},
): GondolinImagePath | undefined {
  const env = deps.env ?? process.env;
  const envOverride = env[IMAGE_ENV_VAR]?.trim();
  if (envOverride) return envOverride;

  const readFile = deps.readFile ?? defaultReadFile;
  const configPath = path.join(hostCwd, CONFIG_RELATIVE_PATH);
  let text: string;
  try {
    text = readFile(configPath);
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw new Error(`${configPath}: could not read (${err instanceof Error ? err.message : String(err)})`);
  }
  return parseConfig(text, configPath).imagePath;
}
