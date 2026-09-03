/**
 * Wraps `@earendil-works/gondolin`'s `VM` lifecycle: creates a micro-VM with
 * the host cwd mounted read/write at `GUEST_WORKSPACE`, and probes the guest
 * image for a real `bash` (falling back to `/bin/sh` — a fresh gondolin image
 * has no guaranteed userspace beyond that). This is the extension's only
 * runtime dependency, and the one file with no unit tests: `VM.create` /
 * `vm.exec` come straight from the gondolin package, with no injectable
 * spawn-style seam to fake — mirrors `pi-extensions/gondolin-reference`'s own
 * `startVm`, split out here so `./tools.ts` only ever depends on the narrow
 * `VmLike` structural type, never this module or the real package directly.
 */

import path from "node:path";
import { RealFSProvider, VM } from "@earendil-works/gondolin";
import type { GondolinImagePath } from "./config.ts";
import type { VmLike } from "./tools.ts";

/** Guest path the host cwd is mounted at — fixed, unlike a devcontainer's `remoteWorkspaceFolder`. */
export const GUEST_WORKSPACE = "/workspace";

/** A running gondolin VM, satisfying `VmLike` structurally (real `VM` has more members than this). */
export interface GondolinVm extends VmLike {
  readonly id: string;
  close(): Promise<void>;
}

export interface StartVmOptions {
  /**
   * Custom guest image to boot instead of gondolin's stock default — see
   * `./config.ts` for how this is resolved (env var / `.pi/gondolin.json`).
   * Passed straight through as `VMOptions.sandbox.imagePath`.
   */
  imagePath?: GondolinImagePath;
}

/** `VM.create` with the host cwd mounted at `GUEST_WORKSPACE`, and an optional custom guest image. */
export async function startVm(hostCwd: string, options: StartVmOptions = {}): Promise<GondolinVm> {
  return VM.create({
    sessionLabel: `pi ${path.basename(hostCwd)}`,
    sandbox: options.imagePath ? { imagePath: options.imagePath } : undefined,
    vfs: {
      mounts: {
        [GUEST_WORKSPACE]: new RealFSProvider(hostCwd),
      },
    },
  });
}

/**
 * Probes the guest for a real `bash` (some gondolin images ship only
 * `/bin/sh`), so `createBashOperations` invokes whichever the guest actually
 * has rather than assuming `bash` is present.
 */
export async function probeShellPath(vm: GondolinVm): Promise<string> {
  const probe = await vm.exec(["/bin/sh", "-lc", "command -v bash || true"]);
  return probe.stdout.trim() || "/bin/sh";
}
