/**
 * studio/enrich/provenanceSignal — did this video come out of a CAMERA? A signal, not a label.
 *
 * `origin = 'upload'` says she uploaded it; it does not say she filmed it. Two uploads in the test
 * library are AI camera-roll videos (enrichment eval, Part 3: never transcoded, score higher on
 * aesthetic than her real 51 s clip) and nothing in the row tells them from her footage. The
 * container does: a phone writes device atoms into the moov box (`com.apple.quicktime.make` /
 * `.model` on iOS, `com.android.*` on Android), a GPS atom, a creation time, an audio track. A
 * generic muxer (`Lavf…`) writes none of that.
 *
 * ─── PRESENCE IS STRONG, ABSENCE PROVES NOTHING ────────────────────────────────────────────────
 *
 * An edited real clip — trimmed in Photos, exported from an app — legitimately loses its atoms.
 * So `no-device-metadata` is "unverified", never "fake", and every consumer of this signal DEMOTES
 * and never excludes (studio/agent/library.ts). `unknown` is a probe that failed or found no video.
 *
 * ─── READ FROM THE ORIGINAL ────────────────────────────────────────────────────────────────────
 *
 * The transcode (services/videoPoster.ts) re-muxes through libx264 with no `-map_metadata`;
 * whether an atom survives is ffmpeg's default, not ours. The original is kept at
 * `metadata.original_gcs_path`; the clip lane probes it over a signed URL — ffprobe reads the
 * moov atom, kilobytes, never the object — and writes the score beside `vision` in one statement.
 *
 * Pure scoring here; the ffprobe transport is injected by the lane and stood in by its tests.
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

export type ProvenanceSignalKind =
  | "device-camera"
  | "no-device-metadata"
  | "unknown";

export interface ProvenanceEvidence {
  make: string | null;
  model: string | null;
  encoder: string | null;
  creationTime: string | null;
  /** creation_time precedes the row's ingest — or null when either is missing. */
  creationBeforeIngest: boolean | null;
  gps: boolean;
  audio: boolean;
}

export interface ProvenanceSignal {
  signal: ProvenanceSignalKind;
  evidence: ProvenanceEvidence;
  probed_at: string;
}

/** ffprobe's `-show_format -show_streams -of json`, the parts read here. */
export interface ContainerProbe {
  format?: { tags?: Record<string, unknown> };
  streams?: { codec_type?: string; tags?: Record<string, unknown> }[];
}

const DEVICE_TAG = /^(com\.apple\.quicktime\.(make|model)|com\.android\.)/i;
const GPS_TAG = /^(com\.apple\.quicktime\.location|location)/i;

const tag = (
  tags: Record<string, unknown> | undefined,
  re: RegExp,
): string | null => {
  for (const [k, v] of Object.entries(tags ?? {}))
    if (re.test(k) && typeof v === "string" && v.trim()) return v.trim();
  return null;
};

/** Score a probe. `ingestedAt` is the row's ingest, for the coherence evidence. */
export function scoreProvenance(
  probe: ContainerProbe | null,
  given: { ingestedAt?: Date | null; now?: Date } = {},
): ProvenanceSignal {
  const now = given.now ?? new Date();
  const empty: ProvenanceEvidence = {
    make: null,
    model: null,
    encoder: null,
    creationTime: null,
    creationBeforeIngest: null,
    gps: false,
    audio: false,
  };
  const video = probe?.streams?.find((s) => s.codec_type === "video");
  if (!probe || !video)
    return { signal: "unknown", evidence: empty, probed_at: now.toISOString() };
  const fmt = probe.format?.tags;
  const all = [fmt, ...(probe.streams ?? []).map((s) => s.tags)];
  const make =
    all
      .map((t) =>
        tag(t, /^(com\.apple\.quicktime\.make|com\.android\.manufacturer)$/i),
      )
      .find(Boolean) ?? null;
  const model =
    all
      .map((t) =>
        tag(t, /^(com\.apple\.quicktime\.model|com\.android\.model)$/i),
      )
      .find(Boolean) ?? null;
  const device = all.some((t) => tag(t, DEVICE_TAG) !== null);
  const creationTime = tag(fmt, /^creation_time$/i);
  const created = creationTime ? new Date(creationTime) : null;
  const evidence: ProvenanceEvidence = {
    make,
    model,
    encoder: tag(fmt, /^encoder$/i),
    creationTime,
    creationBeforeIngest:
      created && !Number.isNaN(created.getTime()) && given.ingestedAt
        ? created.getTime() <= given.ingestedAt.getTime()
        : null,
    gps: all.some((t) => tag(t, GPS_TAG) !== null),
    audio: (probe.streams ?? []).some((s) => s.codec_type === "audio"),
  };
  return {
    signal: device ? "device-camera" : "no-device-metadata",
    evidence,
    probed_at: now.toISOString(),
  };
}

/** The probe transport: a url or path → the container's format and streams, or null on failure. */
export type ContainerProber = (
  source: string,
) => Promise<ContainerProbe | null>;

const PROBE_TIMEOUT_MS = 20_000;

/** ffprobe over a signed URL — the moov atom only. Null on any failure (scored `unknown`). */
export const ffprobeContainer: ContainerProber = async (source) => {
  try {
    const { stdout } = await execFileP(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,https,tls,tcp,crypto",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        source,
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as ContainerProbe;
  } catch {
    return null;
  }
};
