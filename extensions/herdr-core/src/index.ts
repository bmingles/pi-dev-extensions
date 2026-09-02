// Shared Herdr plumbing for the extensions in this repo that drive the `herdr` CLI.
//
// Two of them do, from opposite sides of the container boundary: `herdr-worktrees` runs a
// container-side pi against a container Herdr, and `devcontainer`'s `devcontainer_herdr_*`
// tools run a host-side pi against a host Herdr. They wrap the same binary, so the binary
// resolution, the JSON envelope, the argv builders and the tool-result helpers are the same
// code — the *guards* around them are what differ, and those stay in the callers.
//
// This is a library, not a loadable extension: it has no `pi.extensions` key.
//
// It deliberately does **not** depend on `@andrewjacop/pi-herdr` — see
// `herdr-worktrees/README.md`'s "Why this is a separate extension". Both wrap the same CLI,
// not each other, and a code dependency would couple this repo to a third-party release
// cadence for no gain.

export * from "./herdr-bin.ts";
export * from "./herdr-cli.ts";
export * from "./tilde.ts";
export * from "./tool-result.ts";
export * from "./worktree-create.ts";
export * from "./worktree-layout.ts";
