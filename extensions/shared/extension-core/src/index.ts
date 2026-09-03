// Shared plumbing every extension in this repo needs regardless of which side it runs on
// or what it's about. Side-agnostic *by nature* — see the repo root README's `shared/` rule:
// the moment a unit needs to know which side it's on, it moves out to that side.
//
// This is a library, not a loadable extension: it has no `pi.extensions` key.

export * from "./side.ts";
export * from "./tool-result.ts";
