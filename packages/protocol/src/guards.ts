/**
 * Single canonical runtime object guard for @agent-bus/protocol boundary parsing.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
