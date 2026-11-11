/**
 * use-studio-direction — the direction tools' client half (PR 7): one call per tool, each answering a
 * BriefProposal this client has READ (directionLogic `readProposal`), never a raw body.
 *
 * Same shape as use-studio's planWithAgent: the server's own sentence on anything but a 200, and no
 * tool here spends — a tool answers a brief she confirms; the planner runs only from the flow after
 * that confirm, through the plan call.
 */
import { Platform } from "react-native";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";
import {
  mintBriefUpload,
  putPickedBrief,
  type PickedBrief,
} from "./use-studio";
import {
  readProposal,
  type BriefProposal,
  type PriorContext,
} from "../screens/studio/directionLogic";

const NOT_DATA =
  "That brief didn't arrive as data I can read. Nothing was spent.";

async function callTool(
  path: string,
  body: Record<string, unknown>,
  fallback: string,
  signal?: AbortSignal,
): Promise<BriefProposal> {
  const res = await fetch(new URL(path, getApiUrl()).toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await getAuthHeaders()),
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(
      detail?.error ?? `${fallback} (${res.status}). Nothing was spent.`,
    );
  }
  const raw: unknown = await res.json().catch(() => null);
  const proposal = readProposal(raw);
  if (!proposal) throw new Error(NOT_DATA);
  return proposal;
}

/** THE SPIKE TOOL (commit 1): a fixed brief around her two lines, to prove the channel. Dev only on screen. */
export function echoBrief(
  body: { brand: string; productLine: string },
  signal?: AbortSignal,
): Promise<BriefProposal> {
  return callTool(
    "/api/v1/me/studio/direction/echo",
    body,
    "Couldn't shape that brief",
    signal,
  );
}

/**
 * READ A BRIEF SHE ALREADY UPLOADED (Lane A) — by the path the signed-url door minted (uploadBrief in
 * use-studio.ts). One model call on the server; nothing is planned.
 */
export function summarizeBriefByPath(
  briefFilePath: string,
  signal?: AbortSignal,
): Promise<BriefProposal> {
  return callTool(
    "/api/v1/me/studio/direction/summarize-brief",
    { briefFilePath },
    "Couldn't read that brief",
    signal,
  );
}

/**
 * UPLOAD AND READ A BRIEF IN ONE STEP (Lane A) — the PDF itself, raw, up to 10 MB. The server stores it
 * under her prefix (so a plan row can name it) and reads it. The path comes back beside the proposal;
 * null when the store failed and the reading still happened.
 */
export async function summarizeBriefUpload(
  pdf: Blob | ArrayBuffer | Uint8Array,
  signal?: AbortSignal,
): Promise<{ proposal: BriefProposal; briefFilePath: string | null }> {
  const res = await fetch(
    new URL(
      "/api/v1/me/studio/direction/summarize-brief/upload",
      getApiUrl(),
    ).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        ...(await getAuthHeaders()),
      },
      body: pdf as BodyInit,
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(
      detail?.error ??
        `Couldn't read that brief (${res.status}). Nothing was spent.`,
    );
  }
  const raw: unknown = await res.json().catch(() => null);
  const body =
    typeof raw === "object" && raw !== null
      ? (raw as { proposal?: unknown; briefFilePath?: unknown })
      : null;
  const proposal = readProposal(body?.proposal);
  if (!proposal) throw new Error(NOT_DATA);
  return {
    proposal,
    briefFilePath:
      typeof body?.briefFilePath === "string" ? body.briefFilePath : null,
  };
}

/** The raw route's cap (server/studio/direction/routes.ts MAX_UPLOAD_BYTES), checked before a byte moves. */
export const MAX_BRIEF_BYTES = 10 * 1024 * 1024;

export type BriefUploadPath = "signed-url" | "raw-fallback";

/**
 * READ A BRIEF SHE JUST PICKED (Lane E), by capability: the signed mint first — the production path,
 * the PDF straight to storage, then summarize_brief by its path — and ONLY when the server says this
 * runtime cannot sign (501 signing_unavailable: a laptop's ADC) the raw application/pdf route, which
 * stores under the same prefix and reads in one round trip. Both hand summarize_brief a path under her
 * prefix, so the proposal — and the confirm screen — are the same either way; `via` is for the caller's
 * own log, never for the screen. The server logs one line per path ("brief upload path: …").
 */
export async function summarizeBriefPicked(
  picked: PickedBrief,
  signal?: AbortSignal,
): Promise<{
  proposal: BriefProposal;
  briefFilePath: string | null;
  via: BriefUploadPath;
}> {
  if (picked.size !== null && picked.size > MAX_BRIEF_BYTES)
    throw new Error(
      `That brief is over ${MAX_BRIEF_BYTES / 1048576} MB. Nothing was spent.`,
    );
  const mint = await mintBriefUpload(picked.size);
  if (mint !== "signing_unavailable") {
    await putPickedBrief(picked, mint.uploadUrl);
    const proposal = await summarizeBriefByPath(mint.briefFilePath, signal);
    return { proposal, briefFilePath: mint.briefFilePath, via: "signed-url" };
  }
  return { ...(await summarizeBriefRaw(picked, signal)), via: "raw-fallback" };
}

/** The raw route, on web (the File as the body) and on device (the uri streamed, never in JS memory). */
async function summarizeBriefRaw(
  picked: PickedBrief,
  signal?: AbortSignal,
): Promise<{ proposal: BriefProposal; briefFilePath: string | null }> {
  if (Platform.OS === "web") {
    const body = picked.file ?? (await (await fetch(picked.uri)).blob());
    return summarizeBriefUpload(body, signal);
  }
  const FileSystem = await import("expo-file-system/legacy");
  const put = await FileSystem.uploadAsync(
    new URL(
      "/api/v1/me/studio/direction/summarize-brief/upload",
      getApiUrl(),
    ).toString(),
    picked.uri,
    {
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        "Content-Type": "application/pdf",
        ...(await getAuthHeaders()),
      },
    },
  );
  let raw: unknown = null;
  try {
    raw = JSON.parse(put.body);
  } catch {
    raw = null;
  }
  if (put.status < 200 || put.status >= 300) {
    const detail =
      typeof raw === "object" && raw !== null
        ? (raw as { error?: unknown }).error
        : null;
    throw new Error(
      typeof detail === "string"
        ? detail
        : `Couldn't read that brief (${put.status}). Nothing was spent.`,
    );
  }
  const body =
    typeof raw === "object" && raw !== null
      ? (raw as { proposal?: unknown; briefFilePath?: unknown })
      : null;
  const proposal = readProposal(body?.proposal);
  if (!proposal) throw new Error(NOT_DATA);
  return {
    proposal,
    briefFilePath:
      typeof body?.briefFilePath === "string" ? body.briefFilePath : null,
  };
}

export type { PriorContext } from "../screens/studio/directionLogic";

/**
 * ASK FOR PROPOSALS (Lane B): her objective, a brand if she named one, an occasion if she has one, and
 * optionally what another tool found → two or three distinct BriefProposals, every line inferred with a
 * because, each carrying the concept a picked one rides the plan call with. One Pro call on the server;
 * nothing is planned.
 */
export async function proposeCampaign(
  input: {
    objective: string;
    brand?: string | null;
    occasion?: string | null;
    priorContext?: PriorContext | null;
  },
  signal?: AbortSignal,
): Promise<{ proposals: BriefProposal[]; notes: string[] }> {
  const res = await fetch(
    new URL(
      "/api/v1/me/studio/direction/propose-campaign",
      getApiUrl(),
    ).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(
      detail?.error ??
        `Couldn't find ideas for that (${res.status}). Nothing was spent.`,
    );
  }
  const raw: unknown = await res.json().catch(() => null);
  const body =
    typeof raw === "object" && raw !== null
      ? (raw as { proposals?: unknown; notes?: unknown })
      : null;
  const list = Array.isArray(body?.proposals) ? body.proposals : null;
  if (!list) throw new Error(NOT_DATA);
  const proposals: BriefProposal[] = [];
  for (const item of list) {
    const p = readProposal(item);
    if (!p) throw new Error(NOT_DATA);
    proposals.push(p);
  }
  const notes = Array.isArray(body?.notes)
    ? body.notes.filter((n): n is string => typeof n === "string")
    : [];
  return { proposals, notes };
}

/** A reference she pasted, uploaded, or linked. A link must be a direct image (a page is a 415 with the reason). */
export type ReferenceSource =
  | { kind: "image"; assetId: string }
  | { kind: "text"; text: string }
  | { kind: "url"; url: string };

/**
 * READ A REFERENCE (Lane C): PR 3's engine decomposes it along §7's dimensions; the proposal that comes
 * back is inferred on every line, the decomposition riding as references[0].intent. One Flash call on
 * the server; nothing is planned. A link is fetched and stored as her reference asset first (never
 * offered as her footage); the row's id rides back in `X-Studio-Reference-Asset-Id`.
 */
export async function decomposeReference(
  source: ReferenceSource,
  role: "style_reference" | "composition_reference" = "style_reference",
  signal?: AbortSignal,
): Promise<{ proposal: BriefProposal; referenceAssetId: string | null }> {
  const res = await fetch(
    new URL(
      "/api/v1/me/studio/direction/decompose-reference",
      getApiUrl(),
    ).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
      body: JSON.stringify({ source, role }),
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(
      detail?.error ??
        `Couldn't read that reference (${res.status}). Nothing was spent.`,
    );
  }
  const raw: unknown = await res.json().catch(() => null);
  const proposal = readProposal(raw);
  if (!proposal) throw new Error(NOT_DATA);
  // A link she gave is now one of her rows (origin 'reference'); the flow keeps the id to name it.
  return {
    proposal,
    referenceAssetId: res.headers.get("x-studio-reference-asset-id"),
  };
}

/**
 * FIND A MOMENT (Lane D): her ask, a brand if she named one, a date if she knows it → one live grounded
 * search on the server → a BriefProposal whose story is the moment, cited from the provider's own
 * sources. The date on the proposal is hers or absent; the model never dates anything.
 */
export function researchMoment(
  input: { ask: string; brand?: string | null; date?: string | null },
  signal?: AbortSignal,
): Promise<BriefProposal> {
  return callTool(
    "/api/v1/me/studio/direction/research-moment",
    input,
    "Couldn't find a moment for that",
    signal,
  );
}

/** The trend pillar's answer today: honestly not available, with the reason. Never a proposal. */
export async function trendSignal(
  signal?: AbortSignal,
): Promise<{ available: false; reason: string }> {
  const res = await fetch(
    new URL("/api/v1/me/studio/direction/trend", getApiUrl()).toString(),
    { headers: await getAuthHeaders(), ...(signal ? { signal } : {}) },
  );
  if (!res.ok) {
    throw new Error(
      `Trends aren't available (${res.status}). Nothing was spent.`,
    );
  }
  const raw: unknown = await res.json().catch(() => null);
  const body =
    typeof raw === "object" && raw !== null
      ? (raw as { available?: unknown; reason?: unknown })
      : null;
  return {
    available: false,
    reason:
      typeof body?.reason === "string"
        ? body.reason
        : "No trend signal is available yet.",
  };
}
