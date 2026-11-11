/**
 * CameraRollReviewScreen — "Review my camera roll" (flag off) / "Add from camera roll" (EXPO_PUBLIC_CAMERA_ROLL_INTAKE).
 *
 * She points us at her photos (all of them, or one album); we score them on the phone's own
 * thumbnails with the same vision pass her library already uses; she sees a grid of what we'd keep,
 * each with one line of why; and only the photos she leaves ticked are uploaded.
 *
 * THE CONSENT GRID IS THE POINT. Keepers arrive pre-ticked because that is the recommendation, but
 * nothing at all is stored until she taps Import — "More good ones" starts unticked, "Not
 * recommended" is collapsed with its reasons, and Cancel leaves her library exactly as it was.
 *
 * WITH THE INTAKE ON (design "Media Intake Plan", option c): videos too (a phone-made frame each), what to look at
 * (photos · videos · both) and how far back (new since her last review · 7 days · 30 days), each tile's short
 * description, and Cancel deletes the previews at once. Opened for a POST that needs media (route param `ask`, the
 * shared codec in shared/cameraRollIntake.ts), the review is already filtered, the server leans its ranking toward
 * what the post needs, only the single best match arrives ticked, and the one she imports goes straight into that
 * post's kit (post-kit/use) — then the kit opens. Opened from Mila's one-tap offer (route param `prepared`), the review
 * the app-open check already scored is shown straight away; Import or Cancel clears it, and leaving keeps it on offer.
 *
 * Styling stays inside the existing library's vocabulary (the same chips, tiles and type as
 * MediaLibraryView) — no new design system for one screen.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, Pressable, StyleSheet, FlatList, ScrollView, ActivityIndicator, SafeAreaView,
  StatusBar, useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { Feather } from "@expo/vector-icons";
import * as MediaLibrary from "expo-media-library/legacy";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCameraRollReview, importReviewedPhotos, discardReview, SCAN_LIMIT,
  type ReviewOutcome, type ReviewedPhoto, type ScanProgress,
} from "../hooks/use-camera-roll-review";
import { RightsAckRequired } from "../hooks/use-media-library";
import { RightsAckPanel } from "../components/media/RightsAckPanel";
import { loadReviewedIds, markReviewed } from "../lib/reviewed-assets";
import { useAuth } from "../lib/auth-context";
import { Bold, Colors, Fonts, Spacing } from "../constants/theme";
import { CAMERA_ROLL_INTAKE } from "../lib/flags";
import { durationLabel, errorLineOf, importTally, initialTicks, reviewCopy } from "../lib/cameraRollIntakeLogic";
import { parseCameraRollAsk, type CameraRollKind, type CameraRollSince } from "../../shared/cameraRollIntake";
import { usePostKitWrite } from "../lib/agent/hooks";
import { clearPrepared, loadPrepared } from "../lib/cameraRollPrepared";

type Tab = "keep" | "more" | "drop";
const TABS: { key: Tab; label: string }[] = [
  { key: "keep", label: "Keepers" },
  { key: "more", label: "More good ones" },
  { key: "drop", label: "Not recommended" },
];
const KINDS: { key: CameraRollKind; label: string }[] = [
  { key: "all", label: "Photos and videos" },
  { key: "photos", label: "Photos" },
  { key: "videos", label: "Videos" },
];
const SINCES: { key: CameraRollSince; label: string }[] = [
  { key: "last_review", label: "New since last review" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
];

export function CameraRollReviewScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const qc = useQueryClient();
  const { athlete } = useAuth();
  const athleteId = athlete?.id ?? "anon";
  const { width } = useWindowDimensions();
  const review = useCameraRollReview();
  const kitWrite = usePostKitWrite();

  // The intake's targeted ask (a post that needs media, or a chat card's filter); null for an ordinary review.
  const ask = useMemo(() => (CAMERA_ROLL_INTAKE ? parseCameraRollAsk(route.params?.ask) : null), [route.params?.ask]);
  const forPost = ask?.forPost ?? null;

  const [perm, setPerm] = useState<MediaLibrary.PermissionResponse | null>(null);
  const [albums, setAlbums] = useState<MediaLibrary.Album[] | null>(null);
  const [albumId, setAlbumId] = useState<string | undefined>(undefined);
  const [kind, setKind] = useState<CameraRollKind>(ask?.kind ?? "all");
  const [since, setSince] = useState<CameraRollSince>(ask?.since ?? "last_review");
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<Tab>("keep");
  const [dropOpen, setDropOpen] = useState(false);
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null);
  const [needsAck, setNeedsAck] = useState(false);
  const [tally, setTally] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const gap = 4;
  const pad = Spacing.lg;
  const size = Math.floor((width - pad * 2 - gap * 2) / 3);
  const copy = reviewCopy(kind, outcome?.lookingFor ?? null);

  // ── permission + album list ───────────────────────────────────────────────────────────────────
  const askPermission = useCallback(async () => {
    const res = await MediaLibrary.requestPermissionsAsync();
    setPerm(res);
    // `limited` (iOS "Select photos…") is a perfectly good answer here: we review whatever she
    // chose to share and never ask again for the rest.
    if (res.granted || res.accessPrivileges === "limited") {
      try { setAlbums(await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true })); } catch { setAlbums([]); }
    }
  }, []);
  useEffect(() => { void askPermission(); }, [askPermission]);

  const allowed = !!perm && (perm.granted || perm.accessPrivileges === "limited");

  // Mila's offer: the review the app-open check already prepared opens on its result, no scan.
  const [fromPrepared, setFromPrepared] = useState(false);
  useEffect(() => {
    if (!CAMERA_ROLL_INTAKE || !route.params?.prepared) return;
    let live = true;
    void loadPrepared(athleteId).then((p) => {
      if (!live || !p) return;
      setFromPrepared(true);
      setOutcome(p.outcome);
      setTicked(new Set(p.outcome.keep.map((x) => x.asset.id)));
      setTab("keep");
    });
    return () => { live = false; };
  }, [athleteId, route.params?.prepared]);

  // The intake: a review she leaves without importing deletes its previews at once (the 1-day lifecycle is the backstop).
  const pending = useRef<string | null>(null);
  // A prepared review is not discarded by leaving: it stays on offer until she imports from it or cancels it.
  useEffect(() => { pending.current = fromPrepared ? null : outcome?.sessionId ?? null; }, [outcome, fromPrepared]);
  useEffect(() => () => { if (pending.current) void discardReview(pending.current); }, []);
  // Leaving mid-run stops the run (no more of her roll is read or sent once the screen is gone), and the previews it
  // already sent are discarded when it returns (start(), below) — the session id only exists once the run ends.
  const mounted = useRef(true);
  const stopRun = review.cancel;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (CAMERA_ROLL_INTAKE) stopRun(); };
  }, [stopRun]);

  // ── the run ───────────────────────────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    setError(null); setTally(null); setOutcome(null);
    try {
      // A dated window looks at everything in it, reviewed or not; "new since last review" skips what she has seen.
      const reviewedIds = since === "last_review" || !CAMERA_ROLL_INTAKE ? await loadReviewedIds(athleteId) : new Set<string>();
      const res = await review.run({
        albumId, reviewedIds, onProgress: setProgress,
        ...(CAMERA_ROLL_INTAKE ? { kind, since, ...(forPost ? { target: { forPost } } : {}) } : {}),
      });
      if (CAMERA_ROLL_INTAKE && !mounted.current) { void discardReview(res.sessionId); return; }
      setOutcome(res);
      setTicked(CAMERA_ROLL_INTAKE
        ? initialTicks(res.keep.map((p) => ({ id: p.asset.id, kind: p.entry?.kind, rank: p.entry?.rank ?? 0 })), !!forPost, kind)
        : new Set(res.keep.map((p) => p.asset.id)));   // keepers pre-ticked; nothing else
      setTab("keep");
    } catch (e: any) {
      setError(e?.message ?? "The review didn't finish.");
    } finally {
      setProgress(null);
    }
  }, [albumId, athleteId, review, kind, since, forPost]);

  const shown: ReviewedPhoto[] = useMemo(() => {
    if (!outcome) return [];
    return tab === "keep" ? outcome.keep : tab === "more" ? outcome.more : outcome.drop;
  }, [outcome, tab]);

  const toggle = (id: string) => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const cancelReview = useCallback(() => {
    if (fromPrepared) { void clearPrepared(athleteId, { discard: true }); setFromPrepared(false); }
    else if (outcome) void discardReview(outcome.sessionId);
    pending.current = null;
    setOutcome(null); setTicked(new Set());
  }, [outcome, fromPrepared, athleteId]);

  // ── import ────────────────────────────────────────────────────────────────────────────────────
  const runImport = useCallback(async (ackRights: boolean) => {
    if (!outcome) return;
    // Best first: for a post, the first one imported is the one that goes into its kit.
    const chosen = [...outcome.keep, ...outcome.more]
      .filter((p) => ticked.has(p.asset.id))
      .sort((a, b) => (b.entry?.rank ?? 0) - (a.entry?.rank ?? 0));
    if (!chosen.length) return;
    setError(null);
    setImporting({ done: 0, total: chosen.length });
    try {
      const res = await importReviewedPhotos({
        sessionId: outcome.sessionId, photos: chosen, ackRights,
        onProgress: (p) => setImporting({ done: p.done, total: p.total }),
      });
      setNeedsAck(false);
      // Remember every photo we SHOWED her — keepers and drops alike — so a rescan only looks at
      // what she has shot since. Declining a photo is an answer, and re-asking is the annoying part.
      const seen = [...outcome.keep, ...outcome.more, ...outcome.drop].map((p) => p.asset.id);
      await markReviewed(athleteId, seen);
      qc.invalidateQueries({ queryKey: ["me-media"] });
      pending.current = null;   // imported: the server already deleted the previews
      if (fromPrepared) { void clearPrepared(athleteId); setFromPrepared(false); }
      setTally(CAMERA_ROLL_INTAKE
        ? importTally(res.imported as Array<{ media_type?: string }>, res.failedCount)
        : `Added ${res.imported.length} photo${res.imported.length === 1 ? "" : "s"} to your library` +
          (res.failedCount ? ` — ${res.failedCount} didn't make it` : ""));
      setOutcome(null);
      setTicked(new Set());
      // The targeted ask's last step: the best one she imported goes straight into the post's kit, then the kit opens.
      if (forPost && res.imported.length) {
        try {
          await kitWrite.mutateAsync({ op: "use", id: forPost, assetId: res.imported[0].asset_id });
          nav.navigate("PostKit", { id: forPost });
        } catch (e) {
          setError(errorLineOf(e, "It's in your library, but it couldn't go into the post's kit. Open the kit to add it."));
        }
      }
    } catch (e) {
      if (e instanceof RightsAckRequired) setNeedsAck(true);
      else setError((e as Error)?.message ?? "The import didn't finish.");
    } finally {
      setImporting(null);
    }
  }, [athleteId, outcome, qc, ticked, forPost, kitWrite, nav, fromPrepared]);

  const selectedCount = useMemo(
    () => (outcome ? [...outcome.keep, ...outcome.more].filter((p) => ticked.has(p.asset.id)).length : 0),
    [outcome, ticked],
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <Pressable onPress={() => nav.goBack()} style={styles.icoBtn} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={Colors.light.text} />
        </Pressable>
        <Text style={styles.title}>{CAMERA_ROLL_INTAKE ? copy.title : "Review my camera roll"}</Text>
        <View style={styles.icoBtn} />
      </View>

      {!allowed ? (
        <View style={styles.center}>
          <Feather name="lock" size={26} color={Colors.light.textMuted} />
          <Text style={styles.centerTxt}>
            {CAMERA_ROLL_INTAKE
              ? "Nomila needs permission to look at your photos and videos. Nothing is uploaded until you pick what to keep."
              : "Nomila needs permission to look at your photos. Nothing is uploaded until you pick what to keep."}
          </Text>
          <Pressable style={styles.primaryBtn} onPress={askPermission}><Text style={styles.primaryBtnTx}>{CAMERA_ROLL_INTAKE ? "Allow access" : "Allow photo access"}</Text></Pressable>
        </View>
      ) : !outcome ? (
        <ScrollView contentContainerStyle={styles.setup}>
          {CAMERA_ROLL_INTAKE ? (
            <>
              {forPost ? <Text style={styles.forPost}>For your post: we&apos;ll look for what it needs.</Text> : null}
              <Text style={styles.lede}>{copy.lede}</Text>
              {kind !== "photos" && !review.canPreviewVideo ? (
                <Text style={styles.warn}>This version of the app can&apos;t make video previews, so videos are skipped.</Text>
              ) : null}
            </>
          ) : (
            <>
              <Text style={styles.lede}>
                We&apos;ll look through your latest {SCAN_LIMIT} photos and suggest the ones worth having in your
                library. Only a small thumbnail of each photo leaves your phone for scoring — the full photo
                is uploaded only for the ones you keep.
              </Text>
              <Text style={styles.note}>Photos only for now — videos aren&apos;t reviewed in this version.</Text>
            </>
          )}
          {!review.canResize ? (
            <Text style={styles.warn}>
              This build can&apos;t shrink photos before scoring, so any photo over 400 KB is skipped.
              Installing expo-image-manipulator (a new dev-client build) turns the full review on.
            </Text>
          ) : null}
          {perm?.accessPrivileges === "limited" ? (
            <Text style={styles.note}>You&apos;ve shared a selection of photos — we&apos;ll review those.</Text>
          ) : null}

          {CAMERA_ROLL_INTAKE ? (
            <>
              <Text style={styles.sectionLabel}>What to look at</Text>
              <View style={styles.chipWrap}>
                {KINDS.map((k) => {
                  const on = kind === k.key;
                  return (
                    <Pressable key={k.key} onPress={() => setKind(k.key)} style={[styles.chip, on && styles.chipOn]}>
                      <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{k.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.sectionLabel}>How far back</Text>
              <View style={styles.chipWrap}>
                {SINCES.map((k) => {
                  const on = since === k.key;
                  return (
                    <Pressable key={k.key} onPress={() => setSince(k.key)} style={[styles.chip, on && styles.chipOn]}>
                      <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{k.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}

          <Text style={styles.sectionLabel}>Where to look</Text>
          <View style={styles.chipWrap}>
            <Pressable onPress={() => setAlbumId(undefined)} style={[styles.chip, !albumId && styles.chipOn]}>
              <Text style={[styles.chipTxt, !albumId && styles.chipTxtOn]}>{CAMERA_ROLL_INTAKE ? "Everything" : "All photos"}</Text>
            </Pressable>
            {(albums ?? []).slice(0, 24).map((a) => {
              const on = albumId === a.id;
              return (
                <Pressable key={a.id} onPress={() => setAlbumId(a.id)} style={[styles.chip, on && styles.chipOn]}>
                  <Text style={[styles.chipTxt, on && styles.chipTxtOn]} numberOfLines={1}>{a.title}</Text>
                </Pressable>
              );
            })}
          </View>

          {progress ? (
            <View style={styles.progressRow}>
              <ActivityIndicator color={Colors.light.primary} />
              <Text style={styles.note}>
                {progress.phase === "scanning"
                  ? CAMERA_ROLL_INTAKE ? "Looking through your camera roll…" : "Looking through your photos…"
                  : `Reviewing ${progress.done} of ${progress.total}…`}
              </Text>
              <Pressable onPress={review.cancel} hitSlop={8}><Text style={styles.cancelTx}>Stop</Text></Pressable>
            </View>
          ) : (
            <Pressable style={styles.primaryBtn} onPress={start} disabled={review.running}>
              <Text style={styles.primaryBtnTx}>{CAMERA_ROLL_INTAKE ? copy.start : "Start review"}</Text>
            </Pressable>
          )}

          {tally ? <Text style={styles.tally}>{tally}</Text> : null}
          {error ? <Text style={styles.err}>{error}</Text> : null}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>
          <View style={styles.tabs}>
            {TABS.map((t) => {
              const on = tab === t.key;
              const n = t.key === "keep" ? outcome.keep.length : t.key === "more" ? outcome.more.length : outcome.drop.length;
              return (
                <Pressable key={t.key} onPress={() => setTab(t.key)} style={[styles.tab, on && styles.tabOn]}>
                  <Text style={[styles.tabTxt, on && styles.tabTxtOn]}>{t.label} {n}</Text>
                </Pressable>
              );
            })}
          </View>

          {outcome.lookingFor ? <Text style={styles.note}>Looking for: {outcome.lookingFor}</Text> : null}
          {outcome.limitNote ? <Text style={styles.note}>{outcome.limitNote}</Text> : null}
          {!outcome.likenessAvailable && outcome.likenessNote ? (
            <Text style={styles.note}>{outcome.likenessNote}</Text>
          ) : null}
          {outcome.skipped.screenshots || outcome.skipped.alreadyReviewed || outcome.skipped.tooLarge || outcome.skipped.bursts ? (
            <Text style={styles.note}>
              Skipped on your phone: {outcome.skipped.screenshots} screenshots · {outcome.skipped.alreadyReviewed} already
              reviewed{outcome.skipped.bursts ? ` · ${outcome.skipped.bursts} near-duplicates` : ""}{outcome.skipped.tooLarge ? ` · ${outcome.skipped.tooLarge} too large to review` : ""}
            </Text>
          ) : null}

          {tab === "drop" && !dropOpen ? (
            <View style={styles.center}>
              <Text style={styles.centerTxt}>
                {outcome.drop.length} {CAMERA_ROLL_INTAKE ? "item" : "photo"}{outcome.drop.length === 1 ? "" : "s"} we wouldn&apos;t add — each with a reason.
              </Text>
              <Pressable style={styles.secondaryBtn} onPress={() => setDropOpen(true)}>
                <Text style={styles.secondaryBtnTx}>Show them</Text>
              </Pressable>
            </View>
          ) : (
            <FlatList
              data={shown}
              keyExtractor={(p) => p.asset.id}
              numColumns={3}
              columnWrapperStyle={{ gap, paddingHorizontal: pad }}
              contentContainerStyle={{ gap, paddingTop: 8, paddingBottom: 120 }}
              ListEmptyComponent={<View style={styles.center}><Text style={styles.centerTxt}>Nothing here.</Text></View>}
              renderItem={({ item: p }) => (
                <ReviewTile
                  photo={p}
                  size={size}
                  selectable={tab !== "drop"}
                  selected={ticked.has(p.asset.id)}
                  onPress={() => tab !== "drop" && toggle(p.asset.id)}
                />
              )}
            />
          )}

          <View style={styles.footer}>
            {needsAck ? (
              <RightsAckPanel busy={!!importing} onConfirm={() => runImport(true)} onCancel={() => setNeedsAck(false)} />
            ) : (
              <>
                {error ? <Text style={styles.err}>{error}</Text> : null}
                <View style={styles.footerRow}>
                  <Pressable onPress={cancelReview} hitSlop={8}>
                    <Text style={styles.cancelTx}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.primaryBtn, (!selectedCount || !!importing) && styles.btnOff]}
                    onPress={() => runImport(false)}
                    disabled={!selectedCount || !!importing}
                  >
                    {importing ? (
                      <Text style={styles.primaryBtnTx}>Importing {importing.done} of {importing.total}…</Text>
                    ) : (
                      <Text style={styles.primaryBtnTx}>{forPost ? "Use in my post" : `Import ${selectedCount} selected`}</Text>
                    )}
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

function ReviewTile({
  photo, size, selected, selectable, onPress,
}: { photo: ReviewedPhoto; size: number; selected: boolean; selectable: boolean; onPress: () => void }) {
  const line = photo.entry?.reason ?? photo.drop?.reason ?? "";
  const flaggedContent = photo.drop?.code === "content";
  const isVideo = photo.asset.mediaType === MediaLibrary.MediaType.video;
  const length = isVideo ? durationLabel(photo.asset.duration) : null;
  const summary = photo.entry?.summary;
  return (
    <Pressable style={[styles.tile, { width: size }]} onPress={onPress} disabled={!selectable}>
      <Image source={{ uri: photo.asset.uri }} style={{ width: size, height: size }} contentFit="cover" />
      {selectable ? (
        <View style={[styles.check, selected && styles.checkOn]}>
          {selected ? <Feather name="check" size={12} color="#fff" /> : null}
        </View>
      ) : null}
      {photo.entry && photo.entry.tags.brand_safe === false ? (
        <View style={styles.caution}><Feather name="alert-triangle" size={9} color={Bold.onDark} /></View>
      ) : null}
      {flaggedContent ? <View style={styles.blocked}><Feather name="slash" size={9} color="#fff" /></View> : null}
      {isVideo ? (
        <View style={[styles.videoBadge, { top: size - 24 }]}>
          <Feather name="video" size={10} color="#fff" />
          {length ? <Text style={styles.videoBadgeTx}>{length}</Text> : null}
        </View>
      ) : null}
      <Text style={styles.reason} numberOfLines={2}>{line}</Text>
      {summary ? (
        <Text style={styles.meta} numberOfLines={1}>{[summary.shotType, summary.setting, summary.quality].filter(Boolean).join(" · ")}</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  icoBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, textAlign: "center", fontFamily: Fonts.heading, fontSize: 18, fontWeight: "700", color: Colors.light.text },
  setup: { padding: Spacing.lg, gap: 12 },
  lede: { fontFamily: Fonts.body, fontSize: 14, lineHeight: 21, color: Colors.light.text },
  forPost: { fontFamily: Fonts.bodySemiBold, fontSize: 13.5, fontWeight: "600", color: Colors.light.text },
  note: { fontFamily: Fonts.bodyMedium, fontSize: 12.5, lineHeight: 18, color: Colors.light.textMuted, paddingHorizontal: Spacing.lg, paddingTop: 8 },
  warn: { fontFamily: Fonts.bodyMedium, fontSize: 12.5, lineHeight: 18, color: "#8A6D1B" },
  sectionLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 12.5, fontWeight: "600", color: Colors.light.textSecondary, paddingTop: 6 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  chip: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999, backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border, maxWidth: 200 },
  chipOn: { backgroundColor: Colors.light.text, borderColor: Colors.light.text },
  chipTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 12, fontWeight: "600", color: Colors.light.textSecondary },
  chipTxtOn: { color: Colors.light.backgroundRoot },
  tabs: { flexDirection: "row", gap: 8, paddingHorizontal: Spacing.lg, paddingTop: 6 },
  tab: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border },
  tabOn: { backgroundColor: Colors.light.text, borderColor: Colors.light.text },
  tabTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 12, fontWeight: "600", color: Colors.light.textSecondary },
  tabTxtOn: { color: Colors.light.backgroundRoot },
  tile: { borderRadius: 10, overflow: "hidden", backgroundColor: Colors.light.backgroundSecondary },
  check: {
    position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 11, borderWidth: 1.5,
    borderColor: "#fff", backgroundColor: "rgba(13,11,8,0.35)", alignItems: "center", justifyContent: "center",
  },
  checkOn: { backgroundColor: Colors.light.primary, borderColor: Colors.light.primary },
  caution: { position: "absolute", top: 6, left: 6, width: 18, height: 18, borderRadius: 9, backgroundColor: Bold.ink, alignItems: "center", justifyContent: "center" },
  blocked: { position: "absolute", top: 6, left: 6, width: 18, height: 18, borderRadius: 9, backgroundColor: "#B0341F", alignItems: "center", justifyContent: "center" },
  videoBadge: {
    position: "absolute", left: 6, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, height: 18,
    borderRadius: 9, backgroundColor: "rgba(13,11,8,0.55)",
  },
  videoBadgeTx: { fontFamily: Fonts.bodySemiBold, fontSize: 10, fontWeight: "600", color: "#fff" },
  reason: { fontFamily: Fonts.body, fontSize: 10.5, lineHeight: 14, color: Colors.light.textMuted, paddingHorizontal: 3, paddingVertical: 4 },
  meta: { fontFamily: Fonts.bodyMedium, fontSize: 10, lineHeight: 13, color: Colors.light.textSecondary, paddingHorizontal: 3, paddingBottom: 4 },
  center: { alignItems: "center", justifyContent: "center", gap: 12, padding: 40 },
  centerTxt: { fontFamily: Fonts.bodyMedium, fontSize: 13.5, lineHeight: 20, textAlign: "center", color: Colors.light.textMuted },
  primaryBtn: { backgroundColor: Colors.light.primary, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 11, alignItems: "center" },
  primaryBtnTx: { fontFamily: Fonts.bodyBold, fontSize: 13.5, fontWeight: "700", color: "#fff" },
  secondaryBtn: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9, borderWidth: 1, borderColor: Colors.light.border },
  secondaryBtnTx: { fontFamily: Fonts.bodySemiBold, fontSize: 13, fontWeight: "600", color: Colors.light.text },
  btnOff: { opacity: 0.4 },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  footer: {
    position: "absolute", left: 0, right: 0, bottom: 0, padding: Spacing.lg, gap: 10,
    backgroundColor: Colors.light.backgroundRoot, borderTopWidth: 1, borderTopColor: Colors.light.borderLight,
  },
  footerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 14 },
  cancelTx: { fontFamily: Fonts.bodySemiBold, fontSize: 13, fontWeight: "600", color: Colors.light.textMuted },
  tally: { fontFamily: Fonts.bodySemiBold, fontSize: 13, fontWeight: "600", color: Colors.light.text },
  err: { fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: "#B0341F" },
});
