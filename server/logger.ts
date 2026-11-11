import pino from "pino";
import type { Request, Response, NextFunction } from "express";

const level = process.env.LOG_LEVEL ?? "info";

// WARNING: pino-pretty must NEVER load in production — adds per-log overhead that degrades voice agent latency.
const transport =
  process.env.NODE_ENV !== "production"
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss",
          ignore: "pid,hostname",
        },
      }
    : undefined;

export const logger = pino({
  level,
  transport,
  // Belt-and-suspenders: never let a token / auth header / OAuth code land in logs
  // even if a call site logs a whole object. (No email bodies are logged anywhere.)
  redact: {
    paths: [
      "req.headers.authorization",
      "headers.authorization",
      // The athlete pass (agent/engine/tools/pass.ts) is a bearer credential for one athlete's tools.
      'req.headers["x-nomila-athlete-pass"]',
      'headers["x-nomila-athlete-pass"]',
      "*.access_token",
      "*.refresh_token",
      "access_token",
      "refresh_token",
      "*.id_token",
      "*.code",
      "token",
      // Email content (sender / subject / body) must never land in logs.
      "from",
      "subject",
      "body",
      "*.body",
    ],
    censor: "[REDACTED]",
  },
});

// Query-string keys whose values must never be logged (OAuth authorization codes,
// state, tokens). We keep the path + benign params and mask only these.
const SENSITIVE_QUERY_KEYS = new Set(["code", "state", "access_token", "refresh_token", "id_token", "token"]);

/** Return req.url with sensitive query values masked. */
function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const path = url.slice(0, q);
  const params = new URLSearchParams(url.slice(q + 1));
  let changed = false;
  for (const key of params.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(key)) {
      params.set(key, "[REDACTED]");
      changed = true;
    }
  }
  return changed ? `${path}?${params.toString()}` : url;
}

/**
 * Factory that returns a named child logger for a given module.
 * Usage: const logger = createLogger('my-module');
 */
export function createLogger(module: string) {
  return logger.child({ module });
}

/**
 * Express middleware that attaches a child logger with a `reqId` field to
 * `res.locals.logger` for optional use by route handlers.
 */
export function requestLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const reqId =
    (req.headers["x-request-id"] as string | undefined) ??
    Math.random().toString(36).slice(2);
  res.locals.logger = logger.child({ reqId, method: req.method, url: redactUrl(req.url) });
  next();
}
