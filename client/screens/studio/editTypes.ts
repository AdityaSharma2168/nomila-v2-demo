/**
 * editTypes — the client's view of the typed edit door (server/studio/edit, PR 9). Mirrors the server's
 * closed vocabulary; the server validates, this only types the wire.
 */
export type StudioEditOp =
  | "recolour"
  | "garment"
  | "product"
  | "background_clean"
  | "ad";

export const STUDIO_EDIT_OPS: readonly StudioEditOp[] = [
  "recolour",
  "garment",
  "product",
  "background_clean",
  "ad",
];

export type EditStatus =
  | "quoted"
  | "running"
  | "ready"
  | "accepted"
  | "discarded"
  | "failed";

/** A row as the server presents it (server/studio/edit/engine.ts presentEdit). */
export interface EditPresented {
  id: string;
  sourceAssetId: string;
  op: StudioEditOp;
  status: EditStatus;
  batchId: string | null;
  /** Signed, while the preview stands (status ready); else null. */
  url: string | null;
  width: number | null;
  height: number | null;
  costQuotedUsd: number | null;
  costUsd: number | null;
  acceptedAssetId: string | null;
  /** A carousel batch's working step — never a candidate, never kept. */
  intermediate: boolean;
  error: string | null;
  createdAt: string;
  expiresAt: string;
  /** Past its expiry: no url, nothing to keep (PR 10, R-7). Absent from an older server: read off expiresAt. */
  expired?: boolean;
}

export interface EditQuote {
  costUsd: number | null;
  unpriced: boolean;
  /** The sentence the op became — what she reads before she pays. */
  sentence: string;
  warnings: string[];
  expiresAt: string;
}

/** One recommendation, grounded: `because` is a verbatim line of her confirmed brief. */
export interface EditRec {
  op: StudioEditOp;
  params: Record<string, unknown>;
  because: string;
  what: string;
}

export interface RecommendAnswer {
  recs: EditRec[];
  skipped: "no_brief" | "timeout" | "error" | "source" | null;
  /** The source gate's copy when the photo cannot be edited — shown, never swallowed. */
  refusal: string | null;
}
