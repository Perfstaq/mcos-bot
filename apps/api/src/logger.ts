import { env } from "./env.js";

type Level = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
const ORDER: Record<Level | "silent", number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
  silent: 100,
};

/**
 * Fastify ships pino; the workers don't need a second logging stack for the
 * handful of lines they emit. Structured JSON in production, readable in dev.
 */
export type Logger = {
  child(bindings: Record<string, unknown>): Logger;
  fatal(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
};

function make(bindings: Record<string, unknown>): Logger {
  const threshold = ORDER[env.LOG_LEVEL];

  const emit = (level: Level) => (obj: unknown, msg?: string) => {
    if (ORDER[level] < threshold) return;
    const fields = typeof obj === "object" && obj !== null ? obj : { detail: obj };
    const message = msg ?? (typeof obj === "string" ? obj : "");
    const record = { level, time: new Date().toISOString(), ...bindings, ...fields, msg: message };
    const line =
      env.NODE_ENV === "production"
        ? JSON.stringify(record)
        : `${level.toUpperCase().padEnd(5)} ${message} ${JSON.stringify({ ...bindings, ...fields })}`;
    if (level === "error" || level === "fatal") console.error(line);
    else console.log(line);
  };

  return {
    child: (extra) => make({ ...bindings, ...extra }),
    fatal: emit("fatal"),
    error: emit("error"),
    warn: emit("warn"),
    info: emit("info"),
    debug: emit("debug"),
  };
}

export const logger = make({});
