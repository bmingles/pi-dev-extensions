/**
 * pi herdr-worktrees extension — the devcontainer `.worktrees` sibling
 * convention (`<repo>.worktrees/<branch>`) plus a bind-mount guard, for a
 * pi orchestrator running INSIDE a devcontainer alongside `pi-herdr`.
 *
 * This is not `extensions/devcontainer` (or `sbx`/`gondolin`): those run pi
 * on the HOST and route built-in tools INTO a container. This extension runs
 * as part of a container-side pi and overrides no built-in tool, so it is
 * not part of that mutual-exclusion group and can be loaded alongside any of
 * them (though it only makes sense inside the container they route into).
 *
 * See README.md for the full contract and rationale.
 *
 * Usage (inside a devcontainer, in a Herdr pane):
 *   pi -e /path/to/pi-dev-extensions/extensions/herdr-worktrees
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realResolveDeps } from "./real-deps.ts";
import { registerHerdrWorktreeTools } from "./tools.ts";

export default function (pi: ExtensionAPI) {
  registerHerdrWorktreeTools(pi, realResolveDeps);
}
