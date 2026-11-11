import type { Request, Response } from "express";

export interface SSEStream {
  // `phase` is the coarse kind of work behind the phrase — "thinking" (the model is deciding or
  // composing) or "tool" (a tool round is running). It drives Mila's avatar + status pill on the
  // client; it carries no tool name, arguments or data. Optional: other streams omit it.
  status(message: string, phase?: StatusPhase): void;
  token(t: string): void;
  done(data?: Record<string, unknown>): void;
  suggestions(list: string[]): void;
  // Additive, field-presence event (sibling to suggestions) carrying proposed
  // durable profile updates for the client to confirm. Scalar-only payloads; the
  // client attaches them to the current answer and NEVER writes without a tap.
  profileUpdates(list: unknown[]): void;
  error(message: string): void;
  close(): void;
  abort(): void;      // cancel the in-flight model call (aborts .signal) without closing the response
  signal: AbortSignal; // pass this to kimiStream to cancel on disconnect
  closed: boolean;
}

export type StatusPhase = "thinking" | "tool";

export function isSSERequest(acceptHeader: string | undefined): boolean {
  return (acceptHeader ?? "").includes("text/event-stream");
}

export function openSSEStream(res: Response, req: Request): SSEStream {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let closed = false;
  const controller = new AbortController();

  // Keepalive every 15s (GFE load balancer drops idle connections)
  const keepalive = setInterval(() => {
    if (!closed) res.write(": keepalive\n\n");
  }, 15_000);

  // Detect client disconnect. The response's own close is the reliable one (it fires when the connection goes, and
  // only after res.end otherwise); the request's is kept as it was.
  const onClose = () => {
    closed = true;
    clearInterval(keepalive);
    controller.abort();
  };
  req.on("close", onClose);
  res.on("close", onClose);

  function write(eventName: string | null, data: unknown) {
    if (closed) return;
    if (eventName) res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    else           res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  const stream: SSEStream = {
    status: (message, phase) => write("status", { type: "status", message, ...(phase ? { phase } : {}) }),
    token:  (t)       => write(null, { token: t }),
    done:   (data = {}) => write(null, { done: true, ...data }),
    // Additive field-presence event — a later {suggestions:[…]} with no `done`
    // field, so the client attaches it without a wire discriminator.
    suggestions: (list) => write(null, { suggestions: list }),
    // Same additive shape — a later {profileUpdates:[…]} the client attaches to
    // the current answer as confirm cards.
    profileUpdates: (list) => write(null, { profileUpdates: list }),
    error:  (message) => { write(null, { error: message }); stream.close(); },
    close:  () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      res.end();
    },
    abort:  () => controller.abort(),
    signal: controller.signal,
    get closed() { return closed; },
  };

  return stream;
}
