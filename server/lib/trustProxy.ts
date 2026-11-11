/**
 * trustProxy.ts — how many proxy hops in front of this server Express should trust when it reads X-Forwarded-For.
 *
 * Cloud Run (the run.app URL and its domain mappings alike) is reached through Google's front end, which APPENDS the
 * address it received the connection from to X-Forwarded-For: a client that sends `X-Forwarded-For: 1.2.3.4` arrives
 * as `1.2.3.4, <real client>`. With `trust proxy = true` Express took the LEFT-most entry, the one the client wrote,
 * so every per-IP rate limit could be dodged by changing a header. Trusting exactly ONE hop takes the right-most
 * entry: the address Google saw.
 *
 * TRUST_PROXY_HOPS overrides the count (a whole number ≥ 0) for a deployment with a different front, e.g. 2 behind
 * an external Application Load Balancer (which appends `<client>, <lb>`). Unset or nonsense ⇒ 1.
 */
export const DEFAULT_TRUST_PROXY_HOPS = 1;

export function trustProxyHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_TRUST_PROXY_HOPS;
  return Number(raw);
}
