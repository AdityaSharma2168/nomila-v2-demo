/**
 * agent/documents/workflow.ts — the document_build process on the Postgres workflow runner (design "Mila and the
 * documents" §The loop). Started only by documents_make (dbSource.startBuild), which is in a run only while
 * AGENT_DOCUMENTS_TOOLS is on.
 *
 *   build  the engine's own build, awaited (services/documents buildDocument): a pitch for one confirmed, researched brand
 *          (~$0.20), the public page's general card, or the brand book (a few cents). Retried once; after that a failure
 *          is an ANSWER ({ status: "failed" }), so the tell step still comes back to the chat and says so. A build is
 *          then checked before it is delivered (verifyBuiltDocument, A4): one that fails is { status: "needs_a_look" },
 *          told as not ready, never as ready.
 *   tell   Mila comes back in each chat that asked (tell.ts): the progress card flips to done (or failed) in place and ONE
 *          assistant row goes under it — a fixed line from code (no model call, no cost) and the document's card. A chat
 *          that asked may not have written its turn yet (a fast build): the step looks again after the runner's backoff,
 *          TELL_ATTEMPTS times, then settles. The follow-up card id is doc-ready:<run>, so a retry never writes twice.
 *
 * One run per document at a time: the active scope is the document (document_build:pitch:<brand id> …), so a second ask
 * for the same document joins the running build and nothing is paid twice; two different pitches can build at once.
 */
import { defineWorkflow } from "../../workflow/registry";
import type { StepDef } from "../../workflow/types";
import type { DocumentKind } from "../../../shared/agent";
import { DOCUMENT_BUILD_PROCESS } from "./config";

export interface DocumentBuildInput {
  kind: DocumentKind;
  /** The pitch's brand (one of hers, resolved when the run started); null for the brand book and the public page. */
  brandId: number | null;
  brandName: string | null;
  /** The angles she asked a pitch to lead with, in her words (≤ 3). */
  angles: string[];
  /** The chats (conversation ids) that asked: the tell step looks again for their turns only while there are some. */
  askedFrom: string[];
}

export const TELL_ATTEMPTS = 3;

export const buildInputOf = (raw: unknown): DocumentBuildInput => {
  const i = (raw ?? {}) as Partial<DocumentBuildInput>;
  const kind: DocumentKind = i.kind === "brand_book" || i.kind === "pitch" ? i.kind : "public_page";
  return {
    kind,
    brandId: kind === "pitch" && typeof i.brandId === "number" && i.brandId > 0 ? i.brandId : null,
    brandName: typeof i.brandName === "string" ? i.brandName.slice(0, 80) : null,
    angles: Array.isArray(i.angles) ? i.angles.filter((x): x is string => typeof x === "string").slice(0, 3) : [],
    askedFrom: Array.isArray(i.askedFrom) ? i.askedFrom.filter((x): x is string => typeof x === "string").slice(0, 10) : [],
  };
};

/** The one-run-at-a-time key: the document. */
export const scopeOfInput = (raw: unknown): string => {
  const i = buildInputOf(raw);
  return `${DOCUMENT_BUILD_PROCESS}:${i.kind === "pitch" ? `pitch:${i.brandId ?? 0}` : i.kind}`;
};

const BUILD_RETRY_ATTEMPTS = 2;

const BUILD: StepDef = {
  name: "build", kind: "model", leaseMs: 15 * 60_000, retry: { maxAttempts: BUILD_RETRY_ATTEMPTS },
  run: async (ctx) => {
    if (!ctx.athleteId) throw new Error("document_build requires an athlete");
    const i = buildInputOf(ctx.runInput);
    if (i.kind === "pitch" && !i.brandId) return { status: "failed", reason: "bad_input" };
    const { buildDocument, verifyBuiltDocument } = await import("../../services/documents");
    try {
      const r = await buildDocument(ctx.athleteId, i.kind, { brandId: i.brandId ?? undefined, angles: i.angles });
      // An expected refusal (switched off, the brand no longer confirmed) is an answer, never a retry.
      if (!r.ok) return { status: "failed", reason: r.code };
      if (r.detail !== "built") return { status: r.detail };
      // CHECK BEFORE DELIVER (A4): a built document that fails its check is not told as ready. An answer, not a retry:
      // a rebuild would spend again on what is most likely the same result.
      // Its own catch, fail CLOSED (verify/deliverable VERIFIER_ERROR_MODE): a check that throws must not reach the
      // catch below, which would rebuild — spend again — on a document that is already built.
      const { logNeedsALook } = await import("../../services/verify/deliverable");
      const v = await verifyBuiltDocument(ctx.athleteId, i.kind, { brandId: i.brandId ?? undefined }).catch((e) => ({
        ok: false as const, kind: "document" as const, status: "needs_a_look" as const, checked: ["verifier_error"],
        failures: [{ check: "verifier_error", reason: `the check itself failed: ${String(e?.message ?? e).slice(0, 200)}` }],
      }));
      if (!v.ok) {
        // The built document stays where the build wrote it (the app's own documents surface reads it), so what failed
        // can be opened and looked at; the chat only never calls it ready.
        logNeedsALook("document_build", v, { runId: ctx.runId, doc: i.kind, athleteId: ctx.athleteId, brandId: i.brandId ?? null });
        return { status: "needs_a_look", checks: v.failures.map((f) => f.check) };
      }
      return { status: "built" };
    } catch (err) {
      if (ctx.attempt < BUILD_RETRY_ATTEMPTS) throw err;
      return { status: "failed", reason: "error" };
    }
  },
};
const TELL: StepDef = {
  name: "tell", kind: "code", leaseMs: 2 * 60_000, retry: { maxAttempts: TELL_ATTEMPTS },
  run: async (ctx) => {
    if (!ctx.athleteId) throw new Error("document_build requires an athlete");
    const i = buildInputOf(ctx.runInput);
    const { tellDocumentReady } = await import("./tell");
    const { dbDocTellChats } = await import("./tellDb");
    const { dbDocumentsSource } = await import("./dbSource");
    const built = (ctx.outputs?.build ?? {}) as { status?: string };
    const r = await tellDocumentReady(
      { chats: dbDocTellChats, source: dbDocumentsSource },
      ctx.athleteId,
      { runId: ctx.runId, input: i, ok: built.status === "built" || built.status === "already_building", needsALook: built.status === "needs_a_look" },
    );
    // A chat that asked may still be writing the turn that holds the progress card: look again after the backoff.
    const found = new Set(r.told.concat(r.alreadyTold));
    if (i.askedFrom.some((c) => !found.has(c)) && ctx.attempt < TELL_ATTEMPTS) {
      throw new Error("tell: a chat that asked is not written yet; looking again");
    }
    return { told: r.told.length, alreadyTold: r.alreadyTold.length };
  },
};

/** v1: build → tell. */
export const DOCUMENT_BUILD = defineWorkflow({ process: DOCUMENT_BUILD_PROCESS, version: 1, steps: [BUILD, TELL], activeScope: scopeOfInput });
