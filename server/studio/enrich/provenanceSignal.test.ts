/**
 * provenanceSignal.test.ts — device atoms in the container are strong; their absence proves nothing.
 *
 * ⚠️ MUTATION, red here by name: score every successful probe `device-camera` — "a generic muxer
 * with no device atom is no-device-metadata" reds.
 */
import { scoreProvenance } from "./provenanceSignal";

const NOW = new Date("2026-09-22T12:00:00Z");
const INGEST = new Date("2026-09-20T12:00:00Z");

describe("scoreProvenance", () => {
  it("an iPhone container — make, model, GPS, creation before ingest, an audio track — is device-camera with its evidence", () => {
    const s = scoreProvenance(
      {
        format: {
          tags: {
            "com.apple.quicktime.make": "Apple",
            "com.apple.quicktime.model": "iPhone 15 Pro",
            "com.apple.quicktime.location.ISO6709":
              "+37.4275-122.1697+030.000/",
            creation_time: "2026-09-19T18:04:11.000000Z",
            encoder: "",
          },
        },
        streams: [{ codec_type: "video" }, { codec_type: "audio" }],
      },
      { ingestedAt: INGEST, now: NOW },
    );
    expect(s.signal).toBe("device-camera");
    expect(s.evidence).toEqual({
      make: "Apple",
      model: "iPhone 15 Pro",
      encoder: null,
      creationTime: "2026-09-19T18:04:11.000000Z",
      creationBeforeIngest: true,
      gps: true,
      audio: true,
    });
    expect(s.probed_at).toBe(NOW.toISOString());
  });

  it("an Android container carries its atoms under com.android.*", () => {
    expect(
      scoreProvenance({
        format: {
          tags: {
            "com.android.version": "14",
            "com.android.manufacturer": "Google",
          },
        },
        streams: [{ codec_type: "video" }],
      }).signal,
    ).toBe("device-camera");
  });

  it("a generic muxer with no device atom is no-device-metadata — unverified, never fake", () => {
    const s = scoreProvenance(
      {
        format: { tags: { encoder: "Lavf60.16.100", major_brand: "isom" } },
        streams: [{ codec_type: "video" }],
      },
      { ingestedAt: INGEST, now: NOW },
    );
    expect(s.signal).toBe("no-device-metadata");
    expect(s.evidence.encoder).toBe("Lavf60.16.100");
    expect(s.evidence.audio).toBe(false);
    expect(s.evidence.creationBeforeIngest).toBeNull();
  });

  it("a failed probe, or one with no video stream, is unknown", () => {
    expect(scoreProvenance(null).signal).toBe("unknown");
    expect(scoreProvenance({ streams: [{ codec_type: "audio" }] }).signal).toBe(
      "unknown",
    );
  });

  it("a creation time AFTER ingest is recorded as incoherent, and still does not decide the signal", () => {
    const s = scoreProvenance(
      {
        format: {
          tags: {
            "com.apple.quicktime.make": "Apple",
            creation_time: "2026-09-21T00:00:00Z",
          },
        },
        streams: [{ codec_type: "video" }],
      },
      { ingestedAt: INGEST },
    );
    expect(s.signal).toBe("device-camera");
    expect(s.evidence.creationBeforeIngest).toBe(false);
  });
});
