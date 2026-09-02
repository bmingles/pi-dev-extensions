/**
 * Small helper so tool `execute()` implementations can set `isError` without
 * tripping TypeScript's excess-property check against `AgentToolResult<T>`
 * (which has no `isError` field of its own — the harness reads it off the
 * result at runtime regardless, the same way `pi-herdr`'s own `ToolReturn`
 * type does).
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export interface ToolResultWithError<T> extends AgentToolResult<T> {
  isError?: boolean;
}

export function okResult<T>(text: string, details: T): ToolResultWithError<T> {
  return { content: [{ type: "text", text }], details };
}

export function errorResult<T>(
  text: string,
  details: T,
): ToolResultWithError<T> {
  return { content: [{ type: "text", text }], details, isError: true };
}
