/**
 * agent/engine/tools/pass.ts (moved from agent/mcp/pass.ts, 5 Nov 2026: every engine's tools use it) — the athlete pass: a short-lived signed statement, made by OUR API, of whose tools a call may use.
 *
 * Design (first written for TrueForge, step 1, §3): for every Mila turn our API issues a pass naming ONE athlete,
 * after its own sign-in and let-in checks. The Mastra turn's in-process tools verify it on every call and take the
 * athlete from it (engine/mastra/tools.ts, registry.ts callPassTool). The model never supplies the athlete. (TrueForge
 * carried it over HTTP to /mcp; both went in Mastra-only PR 3.)
 *
 * First version: a compact JWS, HS256 over NOMILA_MCP_PASS_KEY (Secret Manager). The design's later form is ES256
 * with a Cloud KMS key; only issue/verify change.
 *
 * Claims: sub athlete id · sid conversation or session id · rid agent run id (an agent_runs row: tools record it on
 * what they write) · skill the skill id (its tool list bounds the call) · scp allowed permission levels · iat · exp
 * (10 minutes) · aud "nomila-mcp" · iss "nomila-api" · jti (trace only; no replay store at a 10-minute TTL).
 */
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { TOOL_PERMISSIONS, type ToolPermission } from "../../../../shared/agent";
import { JOB_ID_RE } from "../../jobs";
import { PASS_AUDIENCE, PASS_ISSUER, PASS_TTL_SECONDS, passKey } from "./config";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AthletePass {
  athleteId: string;
  sessionId: string;
  runId: string;
  skillId: string;
  scopes: ToolPermission[];
  expiresAt: number;
  jti: string;
}

const claimsSchema = z.object({
  sub: z.string().regex(UUID_RE),
  sid: z.string().min(1).max(200),
  rid: z.string().regex(UUID_RE),
  skill: z.string().regex(JOB_ID_RE),
  scp: z.array(z.enum(TOOL_PERMISSIONS)).min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  aud: z.literal(PASS_AUDIENCE),
  iss: z.literal(PASS_ISSUER),
  jti: z.string().min(1).max(100),
});

export class PassError extends Error {
  constructor(readonly code: "unconfigured" | "missing" | "invalid" | "expired" | "wrong_audience" | "wrong_issuer" | "bad_claims", message: string) { super(message); }
}

export interface IssuePassInput {
  athleteId: string;
  sessionId: string;
  runId: string;
  skillId: string;
  scopes: readonly ToolPermission[];
  /** Tests only: a fixed clock (seconds). */
  nowSeconds?: number;
}

/** Issue a pass. Only our API calls this, after its own authentication; athletes never see or hold one. */
export function issueAthletePass(input: IssuePassInput, key: string | null = passKey()): string {
  if (!key) throw new PassError("unconfigured", "NOMILA_MCP_PASS_KEY is not set");
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const claims = {
    sub: input.athleteId, sid: input.sessionId, rid: input.runId, skill: input.skillId,
    scp: [...new Set(input.scopes)], iat: now, exp: now + PASS_TTL_SECONDS,
    aud: PASS_AUDIENCE, iss: PASS_ISSUER, jti: randomUUID(),
  };
  // Validate what we sign, so a bad issuer call fails here rather than on every tool call.
  const ok = claimsSchema.safeParse(claims);
  if (!ok.success) throw new PassError("bad_claims", `pass claims invalid: ${ok.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return jwt.sign(claims, key, { algorithm: "HS256" });   // iat is ours (claims.iat), kept as given
}

/**
 * Verify a pass: HS256 only (no other algorithm, never "none"), signature, aud, iss, exp, a lifetime no longer than
 * 10 minutes, and well-formed claims. Throws PassError; never returns a partly-checked pass.
 */
export function verifyAthletePass(token: string | undefined | null, key: string | null = passKey(), nowSeconds?: number): AthletePass {
  if (!key) throw new PassError("unconfigured", "the pass key is not configured");
  if (!token || typeof token !== "string") throw new PassError("missing", "no athlete pass");
  let raw: unknown;
  try {
    raw = jwt.verify(token, key, {
      algorithms: ["HS256"], audience: PASS_AUDIENCE, issuer: PASS_ISSUER, clockTolerance: 5,
      ...(nowSeconds != null ? { clockTimestamp: nowSeconds } : {}),
    });
  } catch (err: any) {
    if (err?.name === "TokenExpiredError") throw new PassError("expired", "the athlete pass has expired");
    const msg = String(err?.message ?? "");
    if (msg.startsWith("jwt audience invalid")) throw new PassError("wrong_audience", "the athlete pass is not for this server");
    if (msg.startsWith("jwt issuer invalid")) throw new PassError("wrong_issuer", "the athlete pass was not issued by Nomila");
    throw new PassError("invalid", "the athlete pass is not valid");
  }
  const parsed = claimsSchema.safeParse(raw);
  if (!parsed.success) throw new PassError("bad_claims", "the athlete pass is missing claims");
  const c = parsed.data;
  if (c.exp - c.iat > PASS_TTL_SECONDS || c.exp <= c.iat) throw new PassError("bad_claims", "the athlete pass lives too long");
  return { athleteId: c.sub, sessionId: c.sid, runId: c.rid, skillId: c.skill, scopes: c.scp, expiresAt: c.exp, jti: c.jti };
}
