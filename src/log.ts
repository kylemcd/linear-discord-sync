/**
 * Structured JSON logs, read in Workers Logs. Every sync log carries
 * operation + result, plus discordThreadId / linearIssueId /
 * linearIssueIdentifier when known.
 */
export type LogFields = {
  operation: string;
  result?: "success" | "skipped" | "retry" | "error" | "fatal" | "info";
  discordThreadId?: string;
  linearIssueId?: string;
  linearIssueIdentifier?: string | null;
  [key: string]: unknown;
};

function emit(level: "info" | "warn" | "error", fields: LogFields): void {
  const line = JSON.stringify({ level, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (fields: LogFields) => emit("info", fields),
  warn: (fields: LogFields) => emit("warn", fields),
  error: (fields: LogFields) => emit("error", fields),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
