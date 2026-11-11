/**
 * agent/documents/source.ts — what Mila's documents tools read and do, as ONE port (DocumentsSource). The tools never
 * touch the database or a route: the app passes the database adapter (dbSource.ts, over services/documents and the
 * workflow runner), tests and the chat eval pass the in-memory one (memorySource.ts). Every method takes the RUN's
 * athlete id (ToolContext), never one from model arguments.
 *
 * One vocabulary with the service (services/documents DocKind): brand_book · public_page · pitch. A pitch is always for
 * one of the athlete's OWN brands (the brands of her threads, her deals and her pitches), resolved here from a name —
 * never a brand id the model chose.
 */
import type { DocumentKind, DocumentState } from "../../../shared/agent";

export const DOC_KINDS = ["brand_book", "public_page", "pitch"] as const satisfies readonly DocumentKind[];
export const CHANGES = ["pick_line", "write_line", "next_photo"] as const;
export type Change = (typeof CHANGES)[number];

/** One of the athlete's brands, as a pitch needs it. */
export interface DocBrand {
  id: number;
  name: string;
  logoUrl: string | null;
  /** Research confirmed to describe this company (#778). A pitch is written only for a confirmed brand. */
  confirmed: boolean;
  /** Confirmed research has something to write from (what it does, values, audience or campaigns). */
  researched: boolean;
}

export type DocRef = { kind: "brand_book" } | { kind: "public_page" } | { kind: "pitch"; brand: DocBrand };

/** Where one document stands. Built by the source from the engine's own state; never model text. */
export interface DocSummary {
  kind: DocumentKind;
  brand: DocBrand | null;
  state: DocumentState;
  updatedAt: string | null;
  /** Signed cover image (about an hour), or null. For a card only; the model never reads it. */
  thumbUrl: string | null;
  /** Pitch: shared at least once (a live link exists) and its opens. */
  shared: { opens: number } | null;
  /** Pitch: the public card was rebuilt after this pitch (it may be out of date). */
  stale: boolean;
  /** Public page: whether it is published (and its version), and whether the current draft can be published. */
  published: { version: number | null } | null;
  canPublish: boolean | null;
  blockedReason: string | null;
  /** Brand book: why the last build failed (the engine's own words), when it did. */
  error: string | null;
}

export interface DocOverview {
  /** Each engine's flag: a document whose engine is off is listed as unavailable, never as missing. */
  available: { brandBook: boolean; engine: boolean; publicPage: boolean };
  brandBook: DocSummary | null;
  publicPage: DocSummary | null;
  pitches: DocSummary[];
  /** Her brands a pitch can be written for now (confirmed + researched) that have none yet, at most a few. */
  pitchable: Array<Pick<DocBrand, "id" | "name">>;
}

/** One page or card, with the lines that can change on it. `options` are the stored alternatives (pick_line indexes them). */
export interface DocPage {
  id: string;
  title: string;
  lines: Array<{ slot: string; text: string; options: string[] }>;
  /** A photo the athlete can swap (next_photo). */
  photo: boolean;
}

export type DocChange =
  | { change: "pick_line"; page: string; slot: string; option: number }
  | { change: "write_line"; page: string; slot: string; text: string }
  | { change: "next_photo"; page: string };

/** Why a document could not be read or changed; each says what to do next (tools.ts errorFor). */
export type DocSourceError =
  | "feature_off" | "not_found" | "not_built" | "building" | "brand_not_confirmed" | "no_research" | "bad_input"
  | "daily_limit" | "blocked" | "failed";
export type Got<T> = { ok: true; value: T } | { ok: false; error: DocSourceError; detail?: string };

export type BrandLookup = { found: DocBrand } | { ambiguous: string[] } | { none: true };

export interface DocumentsSource {
  overview(athleteId: string): Promise<DocOverview>;
  /** One document's standing (for its card), or null when it does not exist. */
  summary(athleteId: string, ref: DocRef): Promise<DocSummary | null>;
  /** One of HER brands by name (part of the name is enough when it names one brand). */
  brand(athleteId: string, name: string): Promise<BrandLookup>;
  pages(athleteId: string, ref: DocRef): Promise<Got<DocPage[]>>;
  /**
   * Start (or join) the background build of a whole document: the document_build workflow. The chat turn never waits.
   * `conversationId` is the chat that asked: the run comes back to it when the document is ready.
   */
  startBuild(athleteId: string, ref: DocRef, p: { angles: string[]; conversationId: string | null }): Promise<Got<{ runId: string; joined: boolean }>>;
  /** Change one line or photo on the private draft, at once. */
  edit(athleteId: string, ref: DocRef, change: DocChange): Promise<Got<{ text: string | null }>>;
  /** Her tap only (documents_share is an act tool): a live share link for one pitch. */
  sharePitch(athleteId: string, brand: DocBrand): Promise<Got<{ url: string }>>;
  /** Her tap only: publish the public page's current draft. */
  publishPage(athleteId: string): Promise<Got<{ url: string | null; version: number }>>;
}
