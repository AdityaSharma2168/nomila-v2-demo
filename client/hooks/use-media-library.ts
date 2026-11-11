/**
 * use-media-library — the athlete's durable media library (GET /api/v1/me/media) + camera-roll
 * upload. Uploads go straight to GCS via a signed URL, register as a media_asset (origin=upload),
 * and run the same vision-tag + embed enrichment synced media does. Powers the card editor's
 * photo/video picker (client/components/card/CardEditorSheet.tsx).
 */
import { useInfiniteQuery, useQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";
// SDK 54 moved the classic FileSystem API (uploadAsync / FileSystemUploadType) to the `legacy` entry.
import * as FileSystem from "expo-file-system/legacy";
import { apiRequest } from "../lib/query-client";

export interface MediaItem {
  id: string | null;              // source_media_id (null for uploads)
  asset_id: string;
  gcs_path: string;               // durable pick id — card overrides key on this
  platform: string;
  origin: string;                 // connected | discovery | upload | generated → source badge
  media_type: string;             // IMAGE | VIDEO | REELS | CAROUSEL_ALBUM
  url: string | null;
  thumb_url: string | null;
  video_url: string | null;
  poster_gcs_path: string | null; // durable poster path (video override carries it)
  duration_seconds: number | null;
  enriched: boolean;              // false ⇒ still processing (held out of auto-curation)
  brand_safe: boolean | null;
  shot_type: string | null;
  brands_visible: string[];
  views?: number | null;
  /**
   * PR 12 lane 3 — absent from a server with STUDIO_LIBRARY_FIELDS off. The same names and shapes
   * the Studio picker's MediaPhoto carries, so one `tileLabel` serves both screens.
   */
  tagged?: boolean;
  subject?: string | null;
  hero?: number | null;
  reject?: boolean;
  face?: string | null;
  madeHereNotHer?: boolean;
}

export interface MediaSummary {
  total: number;
  by_type: { photos: number; videos: number };
  by_platform: Record<string, number>;
  rights_ack: boolean;
}

interface MediaCursor { posted: string; id: string; hero?: number }
interface MediaPage {
  items: MediaItem[];
  top?: MediaItem[];
  summary?: MediaSummary;
  next_cursor: MediaCursor | null;
}

export type MediaTypeFilter = "photos" | "videos" | undefined;

/** Paginated library, optionally filtered to photos/videos, a source (origin), and a text query
 *  (search over the vision analysis + caption). First page carries `summary`. */
export function useMyMedia(type?: MediaTypeFilter, extra?: { source?: string; q?: string }) {
  const source = extra?.source && extra.source !== "all" ? extra.source : undefined;
  const q = extra?.q?.trim() || undefined;
  return useInfiniteQuery<MediaPage, Error, InfiniteData<MediaPage, MediaCursor | null>, (string | undefined)[], MediaCursor | null>({
    queryKey: ["me-media", type ?? "all", source ?? "all", q ?? ""],
    initialPageParam: null,
    queryFn: async ({ pageParam }) => {
      const p = new URLSearchParams();
      if (type)   p.set("type", type);
      if (source) p.set("source", source);
      if (q)      p.set("q", q);
      if (pageParam?.posted) p.set("cursor_posted", pageParam.posted);
      if (pageParam?.id)     p.set("cursor_id", pageParam.id);
      if (typeof pageParam?.hero === "number") p.set("cursor_hero", String(pageParam.hero));
      const res = await apiRequest("GET", `/api/v1/me/media?${p.toString()}`);
      return res.json();
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

// ─── One asset's full vision analysis ("What Mila saw") — GET /me/media/:assetId ───

export interface MediaVision {
  athlete_present: boolean;
  athlete_prominence: number;   // 0..1
  shot_type: string;            // portrait | action | lifestyle | group | text_graphic | other
  description: string;
  brands_visible?: string[];    // raw Gemini vision JSON — may omit this key; readers MUST guard
  aesthetic_quality: number;    // 0..1
  brand_safe: boolean;
  setting: string; attire: string; vibe: string;
  hero_suitability: number;     // 0..1
  disposition: string;          // as_is | crop | enhance | reject
  edit_note: string;
  reason: string;
}

export interface MediaDetail extends MediaItem {
  vision: MediaVision | null;
  embedded: boolean;
  /** A VIDEO's clip-read state (PR 9.5, B4); null on an image. Absent from an older server. */
  read?: import("../screens/studio/clipReadLogic").ClipRead | null;
  caption?: string | null;
  permalink?: string | null;
  posted_at?: string | null;
  like_count?: number | null;
  comments_count?: number | null;
  reach?: number | null;
  saves?: number | null;
}

export function useMediaDetail(assetId: string | undefined) {
  const query = useQuery<MediaDetail>({
    queryKey: [`/api/v1/me/media/${assetId}`],
    enabled:  !!assetId,
  });
  return { detail: query.data, isLoading: query.isLoading, error: query.error as Error | null };
}

/** Default cap on assets accepted from a single multi-select camera-roll pick. */
const DEFAULT_SELECTION_LIMIT = 20;

export interface CameraRollPickOptions {
  /** Allow picking more than one asset at once. Default false (single-select, unchanged). */
  multiple?: boolean;
  /** Max assets to accept for a multi-select pick. Default 20. Only meaningful with `multiple`. */
  selectionLimit?: number;
}

export interface CameraRollPickResult {
  assets: ImagePicker.ImagePickerAsset[];
  /**
   * Present only when the athlete selected more than `selectionLimit` and we cut the list down
   * in code — see the platform note below: `selectionLimit` is NOT reliably enforced by the OS.
   */
  truncated?: { picked: number; kept: number };
}

/**
 * Launch the OS picker (permission-gated), filtered to the card-compatible media type.
 *
 * Single-select by default (unchanged). Pass `{ multiple: true }` to allow picking several
 * assets at once — the caller gets back `res.assets` in full, in the order she tapped them
 * (`orderedSelection`).
 *
 * PLATFORM NOTE — `selectionLimit` is not honoured everywhere: expo-image-picker's
 * `allowsMultipleSelection` works on iOS, Android and web alike, but `selectionLimit` is only
 * enforced by the OS's own picker UI on iOS 14+ and Android 13+ (the system photo picker) — on
 * web (a plain `<input type=file multiple>`) and on older Android it is silently ignored, so an
 * athlete there could hand back an arbitrarily long list. We therefore ALWAYS trim `res.assets`
 * to the limit here in code, regardless of platform, and report back how many were cut so the
 * caller can tell her ("Uploading the first 20 of 34 selected").
 */
export async function pickFromCameraRoll(
  accept: "photo" | "video" | "all",
  options?: CameraRollPickOptions,
): Promise<CameraRollPickResult | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return null;
  const mediaTypes: ImagePicker.MediaType[] =
    accept === "photo" ? ["images"] : accept === "video" ? ["videos"] : ["images", "videos"];
  const multiple = options?.multiple ?? false;
  const selectionLimit = options?.selectionLimit ?? DEFAULT_SELECTION_LIMIT;
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes,
    quality: 0.9,
    ...(multiple ? { allowsMultipleSelection: true, selectionLimit, orderedSelection: true } : {}),
  });
  if (res.canceled || !res.assets?.length) return null;
  // Always enforce the cap in code — see the platform note above.
  const picked = res.assets.length;
  const assets = multiple && picked > selectionLimit ? res.assets.slice(0, selectionLimit) : res.assets;
  return { assets, truncated: multiple && picked > selectionLimit ? { picked, kept: assets.length } : undefined };
}

function contentTypeFor(a: ImagePicker.ImagePickerAsset): string {
  if (a.mimeType) return a.mimeType;
  return a.type === "video" ? "video/mp4" : "image/jpeg";
}

/** Thrown by the upload when the one-time rights acknowledgment is still needed — the picker catches
 *  this to show the ack panel, then retries with `ackRights: true`. */
export class RightsAckRequired extends Error {
  constructor() { super("rights_ack_required"); this.name = "RightsAckRequired"; }
}

export type UploadRole = "product";

/**
 * The mint → PUT half of an upload, WITHOUT the register.
 *
 * Split out of `uploadOneMedia` because the camera-roll review needs exactly this and then
 * registers through its OWN endpoint (`/me/media/review/import`, which carries the photo's capture
 * date and the review provenance). The alternative — a second copy of the signed-URL dance over
 * there — is how the rights-ack handling and the web/native PUT split would quietly diverge
 * between the app's two upload surfaces.
 */
export async function mintAndPutOriginal(
  asset: ImagePicker.ImagePickerAsset,
  ackRights?: boolean,
): Promise<{ gcsPath: string; contentType: string }> {
  const contentType = contentTypeFor(asset);
  const bytes = asset.fileSize;
  // 1) mint a signed upload URL (may require the one-time rights ack)
  let mint: { gcsPath: string; uploadUrl: string; kind: string; contentType?: string };
  try {
    const r = await apiRequest("POST", "/api/v1/me/media/upload-url", { contentType, bytes, ackRights });
    mint = await r.json();
  } catch (e: any) {
    if (String(e?.message ?? "").includes("rights_ack_required")) throw new RightsAckRequired();
    throw e;
  }
  // 2) PUT the bytes straight to GCS (never through our API).
  //    Web takes its own branch: expo-file-system's uploadAsync does not exist on web (the web
  //    shim implements only the directory constants and uploadAsync throws UnavailabilityError),
  //    and the picker hands us a real File — PUT that directly. The native branch below is
  //    untouched: it streams from disk instead of fetch(uri).blob(), because the latter buffers
  //    the whole file in JS memory and fails on large videos, so nothing ever reached GCS.
  if (Platform.OS === "web") {
    // Signed with the STRIPPED type (server splits off any ";" parameters) — send exactly that
    // back, or GCS rejects the PUT with a signature mismatch.
    const putType = mint.contentType ?? contentType;
    const body = asset.file ?? (await (await fetch(asset.uri)).blob());
    const put = await fetch(mint.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": putType },
      body,
    });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  } else {
    const put = await FileSystem.uploadAsync(mint.uploadUrl, asset.uri, {
      httpMethod: "PUT",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { "Content-Type": contentType },
    });
    if (put.status < 200 || put.status >= 300) throw new Error(`Upload failed (${put.status})`);
  }
  return { gcsPath: mint.gcsPath, contentType };
}

/** The full mint → PUT → register sequence for one asset. Shared by the single-asset mutation
 *  below and the sequential batch uploader — neither wraps the other so a batch item's failure
 *  carries a plain Error (or RightsAckRequired) with nothing else in between. */
async function uploadOneMedia(asset: ImagePicker.ImagePickerAsset, ackRights?: boolean, role?: UploadRole): Promise<MediaItem> {
  const { gcsPath, contentType } = await mintAndPutOriginal(asset, ackRights);
  // 3) register → media_asset (origin=upload) + kick background enrichment
  const reg = await apiRequest("POST", "/api/v1/me/media", {
    gcsPath, contentType,
    width: asset.width, height: asset.height,
    durationSeconds: asset.duration != null ? asset.duration / 1000 : undefined,
    bytes: asset.fileSize,
    // The Mila composer's Product tile: tag the asset as a Studio product reference at registration.
    ...(role ? { role } : {}),
  });
  const { item } = await reg.json();
  return item as MediaItem;
}

export function useUploadMedia() {
  const qc = useQueryClient();
  return useMutation<MediaItem, Error, { asset: ImagePicker.ImagePickerAsset; ackRights?: boolean; role?: UploadRole }>({
    mutationFn: ({ asset, ackRights, role }) => uploadOneMedia(asset, ackRights, role),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["me-media"] }); },
  });
}

export interface BatchUploadProgress { done: number; total: number; current: number }
export interface BatchUploadFailure { asset: ImagePicker.ImagePickerAsset; error: Error }
export interface BatchUploadResult { succeeded: MediaItem[]; failed: BatchUploadFailure[] }

/**
 * Upload several camera-roll picks SEQUENTIALLY — one at a time, never in parallel.
 * `FileSystem.uploadAsync` streams a single file straight off disk; running several at once
 * would just contend for the same device bandwidth/memory with no real speed win, and would
 * make one stalled upload block progress on every other item instead of just its own slot.
 *
 * Progress is reported through the `onProgress` callback passed in the mutation variables
 * (`{ done, total, current }`, `current` 1-indexed) rather than hook state, so the caller keeps
 * its own state for the "Uploading 3 of 12…" line.
 *
 * Rights ack: the ack is a one-time, account-wide attestation, so if the FIRST item throws
 * `RightsAckRequired` every remaining item would fail identically — we stop immediately and
 * rethrow so the caller shows the ack panel once, then retries the whole batch with
 * `ackRights: true`. A `RightsAckRequired` on a LATER item (a slow ack race, in practice) is
 * just recorded as that one item's failure so the rest of the batch still completes.
 */
export function useUploadMediaBatch() {
  const qc = useQueryClient();
  return useMutation<
    BatchUploadResult,
    Error,
    { assets: ImagePicker.ImagePickerAsset[]; ackRights?: boolean; onProgress?: (p: BatchUploadProgress) => void }
  >({
    mutationFn: async ({ assets, ackRights, onProgress }) => {
      const succeeded: MediaItem[] = [];
      const failed: BatchUploadFailure[] = [];
      const total = assets.length;
      for (let i = 0; i < total; i++) {
        const asset = assets[i];
        onProgress?.({ done: i, total, current: i + 1 });
        try {
          succeeded.push(await uploadOneMedia(asset, ackRights));
        } catch (e) {
          if (e instanceof RightsAckRequired && i === 0) throw e;   // never acked — stop, surface once
          failed.push({ asset, error: e as Error });
        }
      }
      onProgress?.({ done: total, total, current: total });
      return { succeeded, failed };
    },
    onSuccess: (result) => { if (result.succeeded.length) qc.invalidateQueries({ queryKey: ["me-media"] }); },
  });
}
