/**
 * PostKitScreen (AGENT_V3 + AGENT_POST_KITS) — a post action's post kit (design "Moments → post kits" §9/§12, build
 * step 5): the idea and why, the moment and goal it's timed for, the chosen media (one clip plays at a time, its clip
 * range once — client/components/postKit/PostKitAssetView.tsx), swap from the shortlist, edit the caption, "I posted
 * it", and Share/Save. Posting stays hers: nothing here publishes anywhere, and "I posted it" only records that she did
 * (behind a confirm tap, so a stray tap records nothing).
 *
 * Reached two ways, both landing here directly (not the library focused on it — server/agent/plan/goals.ts
 * actionView): a Goals-tab action ("post-kit" screen target, agent/navigate.ts) and the Studio library's "Posts"
 * row (agent/studio/items.ts StudioItem.open). It sits in the Studio stack, so its back label is Studio's.
 *
 * States: loading · error (Retry) · closed (the action expired or was skipped: the read answers 409 "closed"; nothing
 * to retry) · nothing built yet (Build it — the same build op the plan uses; a build that makes nothing says why in
 * plain words: held for her never-list, a daily or weekly cap, changed meanwhile) · built · done (posted: read-only —
 * no swap, the caption as text, no Save).
 *
 * The preview render (components/postKit/preview.ts): when it is ready the screen shows it instead of the raw media — a
 * reel's or story's one rendered video (then its parts, small, each with Swap), a carousel's or feed post's rendered
 * slides in place of their assets. While it is being made, or when it failed, the raw media shows with a line under
 * it: "Preparing your preview" (the read is polled while this screen is in view, until it lands or PREVIEW_STALL_MS
 * passes), or "Your preview didn't come out" with Try again (also once it stalled). When the reel lands it plays (the raw
 * clips it replaces are no longer on screen, so a clip she had tapped lets go).
 *
 * Music (AGENT_POST_KIT_MUSIC_CHOICES; components/postKit/MusicChoices.tsx): three suggested tracks — play one to hear
 * it with the preview (the preview restarts, muted, alongside it), "Use this" to put it in the post (the preview is
 * made again with it). A track that owes a credit puts it in the caption while it is in use.
 *
 * Share / Save shares a fresh read with the SAVED caption: an unsaved edit is saved first, then shared.
 */
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Button, Card, Eyebrow, Sheet, StackHeader } from "../../components/ui";
import { mediaFor, PostKitAssetView, ratioOf, usePlaybackAllowed } from "../../components/postKit/PostKitAssetView";
import { buildOutcomeLine, POST_KIT_COPY, writeFailLine } from "../../components/postKit/copy";
import { renderedReel, renderedSlide, retryChangedNothing, usePreviewState, type PreviewState, type RenderedFile } from "../../components/postKit/preview";
import { SHARE_COPY, sharePostKit } from "../../components/postKit/sharePostKit";
import { MusicChoices } from "../../components/postKit/MusicChoices";
import { Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { apiErrorOf, type PostKitWrite, type PostKitWriteResult } from "../../lib/agent/api";
import { useFreshPostKit, usePostKit, usePostKitWrite } from "../../lib/agent/hooks";
import { POST_KIT_CAPTION_CHARS, type PostKitAsset, type PostKitResponse } from "../../../shared/postKit";
import { useNavigation } from "@react-navigation/native";
import { CAMERA_ROLL_INTAKE } from "../../lib/flags";
import { askForKit } from "../../lib/cameraRollIntakeLogic";

/** How long "Confirm posted" waits for the second tap before it goes back to "I posted it". */
export const CONFIRM_POSTED_MS = 4000;

/** The playing slot of a reel's rendered video (the other slots are asset ids). */
const PREVIEW_KEY = "preview";

/** A refusal that means the kit on screen is stale: the sheet closes and the screen shows the fresh read. */
const isStale = (err: unknown) => ["done", "conflict", "closed", "answered"].includes(apiErrorOf(err).code ?? "");

function FailLine({ text, testID }: { text: string; testID: string }) {
  return (
    <View style={styles.failLine} accessibilityLiveRegion="polite" testID={testID}>
      <Feather name="alert-circle" size={15} color={Bold.ink} />
      <Text style={styles.failText}>{text}</Text>
    </View>
  );
}

function IdeaCard({ kit }: { kit: PostKitResponse }) {
  if (!kit.kit) return null;
  const { idea, brief } = kit.kit;
  return (
    <Card bold style={styles.card} testID="post-kit-idea">
      <Eyebrow>{POST_KIT_COPY.idea}</Eyebrow>
      <Text style={styles.hook}>{idea.hook}</Text>
      {brief.show ? <Text style={styles.body}>{brief.show}</Text> : null}
      <View style={styles.whyBlock}>
        <Eyebrow>{POST_KIT_COPY.why}</Eyebrow>
        {kit.why ? <Text style={styles.body}>{kit.why}</Text> : null}
        {kit.moment ? (
          <View style={styles.momentLine} testID="post-kit-moment">
            <Feather name="calendar" size={14} color={Bold.mute} />
            <Text style={styles.momentText}>
              {POST_KIT_COPY.timedFor(kit.moment.name)}{kit.moment.whyNow ? ` — ${kit.moment.whyNow}` : ""}
            </Text>
          </View>
        ) : null}
        {kit.goal ? <Text style={styles.goalText}>{POST_KIT_COPY.forGoal(kit.goal.text)}</Text> : null}
      </View>
    </Card>
  );
}

function SwapSheet({ kit, assetId, busy, error, onPick, onClose }: {
  kit: PostKitResponse; assetId: string; busy: boolean; error: string | null; onPick: (replace: string, withId: string) => void; onClose: () => void;
}) {
  if (!kit.kit) return null;
  const candidates = kit.kit.shortlist.map((id) => mediaFor(kit, id)).filter((m): m is NonNullable<typeof m> => !!m && m.available);
  return (
    <Sheet onClose={onClose} title={POST_KIT_COPY.swapTitle}>
      <View style={styles.sheetBody} testID="post-kit-swap-sheet">
        {candidates.length === 0 ? (
          <Text style={styles.body}>{POST_KIT_COPY.swapEmpty}</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.swapRow}>
            {candidates.map((c, i) => (
              <Pressable
                key={c.assetId}
                disabled={busy}
                onPress={() => { haptics.select(); onPick(assetId, c.assetId); }}
                style={({ pressed }) => [styles.swapTile, pressed && styles.pressed, busy && styles.busy]}
                accessibilityRole="button"
                accessibilityLabel={POST_KIT_COPY.swapOption(c.mediaType, i + 1, candidates.length)}
                accessibilityState={{ disabled: busy }}
                testID={`post-kit-swap-option-${c.assetId}`}
              >
                <PostKitAssetView asset={{ assetId: c.assetId, mediaType: c.mediaType, clip: null, durationSec: null, provenance: "camera" }} media={c} ratio={1} playing={false} muted token={0} />
                {c.mediaType === "clip" ? <View style={styles.swapClipBadge}><Feather name="film" size={12} color={Bold.onDark} /></View> : null}
              </Pressable>
            ))}
          </ScrollView>
        )}
        {busy ? <ActivityIndicator color={Bold.ink} testID="post-kit-swap-busy" /> : null}
        {error ? <FailLine text={error} testID="post-kit-swap-error" /> : null}
      </View>
    </Sheet>
  );
}

function SwapButton({ asset, onSwap }: { asset: PostKitAsset; onSwap: () => void }) {
  return (
    <Button
      bold="small"
      onPress={onSwap}
      icon={<Feather name="repeat" size={14} color={Bold.ink} />}
      accessibilityLabel={POST_KIT_COPY.swapLabel(asset.mediaType)}
      style={styles.swapBtn}
      testID={`post-kit-swap-${asset.assetId}`}
    >
      {POST_KIT_COPY.swap}
    </Button>
  );
}

/** A video on screen is a button (play it, or again); a photo is just a photo. */
function Playable({ video, active, onPlay, testID, children }: { video: boolean; active: boolean; onPlay: () => void; testID: string; children: React.ReactNode }) {
  if (!video) return <>{children}</>;
  return (
    <Pressable onPress={onPlay} accessibilityRole="button" accessibilityLabel={active ? POST_KIT_COPY.playClip : POST_KIT_COPY.showClip} testID={testID}>
      {children}
    </Pressable>
  );
}

/** One of the kit's positions: its rendered slide when the preview is ready (a feed post or carousel), else the asset itself. */
function AssetBlock({ kit, asset, rendered, active, playable, token, editable, onPlay, onSwap }: {
  kit: PostKitResponse; asset: PostKitAsset; rendered: RenderedFile | null; active: boolean; playable: boolean; token: number; editable: boolean; onPlay: () => void; onSwap: () => void;
}) {
  const media = mediaFor(kit, asset.assetId);
  const ratio = kit.kit ? ratioOf(kit.kit.treatmentPlan.aspect) : 4 / 5;
  const video = rendered ? rendered.kind === "video" : asset.mediaType === "clip" && !!media?.available && !!media.videoUrl;
  return (
    <View style={styles.assetBlock}>
      <Playable video={video} active={active} onPlay={onPlay} testID={`post-kit-play-${asset.assetId}`}>
        <PostKitAssetView asset={asset} media={media} rendered={rendered} ratio={ratio} playing={active && playable} muted token={token} maxHeight={420} />
      </Playable>
      {editable && kit.kit && kit.kit.shortlist.length > 0 ? <SwapButton asset={asset} onSwap={onSwap} /> : null}
    </View>
  );
}

/**
 * A reel or story whose preview is ready: the rendered cut itself (one video, played once; tap to play again), then
 * the photos and clips it was cut from, small, each with its Swap — a swap changes the cut, so its preview is made again.
 */
function ReelBlock({ kit, reel, active, playable, token, editable, onPlay, onSwap }: {
  kit: PostKitResponse; reel: RenderedFile; active: boolean; playable: boolean; token: number; editable: boolean; onPlay: () => void; onSwap: (assetId: string) => void;
}) {
  if (!kit.kit) return null;
  const assets = kit.kit.assets;
  const first = assets.find((a) => a.assetId === reel.sourceAssetId) ?? assets[0];
  const swappable = editable && kit.kit.shortlist.length > 0;
  return (
    <View style={styles.assetBlock}>
      <Playable video active={active} onPlay={onPlay} testID="post-kit-play-preview">
        <PostKitAssetView asset={first} media={mediaFor(kit, first.assetId)} rendered={reel} ratio={ratioOf(kit.kit.treatmentPlan.aspect)} playing={active && playable} muted token={token} maxHeight={420} />
      </Playable>
      {swappable ? (
        <View style={styles.partsBlock} testID="post-kit-parts">
          <Eyebrow>{POST_KIT_COPY.inThisPost}</Eyebrow>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.swapRow}>
            {assets.map((a) => (
              <View key={a.assetId} style={styles.part}>
                <View style={styles.swapTile}>
                  <PostKitAssetView asset={a} media={mediaFor(kit, a.assetId)} ratio={1} playing={false} muted token={0} />
                  {a.mediaType === "clip" ? <View style={styles.swapClipBadge}><Feather name="film" size={12} color={Bold.onDark} /></View> : null}
                </View>
                <SwapButton asset={a} onSwap={() => onSwap(a.assetId)} />
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

/** The preview while it isn't ready: being made (a quiet line), or it failed (say so, and "Try again" while she can edit). */
function PreviewLine({ state, canRetry, busy, onRetry }: { state: PreviewState; canRetry: boolean; busy: boolean; onRetry: () => void }) {
  if (state === "preparing") {
    return (
      <View style={styles.previewLine} accessibilityLiveRegion="polite" testID="post-kit-preview-preparing">
        <ActivityIndicator size="small" color={Bold.mute} />
        <Text style={styles.previewText}>{POST_KIT_COPY.previewPreparing}</Text>
      </View>
    );
  }
  if (state !== "failed") return null;
  return (
    <View style={styles.previewLine} accessibilityLiveRegion="polite" testID="post-kit-preview-failed">
      <Feather name="alert-circle" size={15} color={Bold.ink} />
      <Text style={[styles.previewText, styles.previewTextInk]}>{POST_KIT_COPY.previewFailed}</Text>
      {canRetry ? (
        <Button bold="small" onPress={onRetry} disabled={busy} loading={busy} testID="post-kit-preview-retry">{POST_KIT_COPY.previewRetry}</Button>
      ) : null}
    </View>
  );
}

/**
 * `route` is the prop React Navigation injects on a registered screen (MainTabNavigator.tsx StudioStackParamList
 * "PostKit": { id }) — taken as an explicit prop, not `useRoute()`, so the dev gallery can render this directly with
 * a chosen id, the same way GoalsTabScreen.tsx's GoalsTab does for `goalId`.
 */
export function PostKitScreen({ route }: { route?: { params?: { id?: string } } } = {}) {
  const id = route?.params?.id ?? null;
  const nav = useNavigation<any>();
  const playable = usePlaybackAllowed();
  // This screen is the one observer that polls its kit while the preview is made — only while it is in view.
  const q = usePostKit(id, { poll: playable });
  const write = usePostKitWrite();
  const freshKit = useFreshPostKit();
  const [caption, setCaption] = useState<string | null>(null);
  const [captionFocused, setCaptionFocused] = useState(false);
  const [swapFor, setSwapFor] = useState<string | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [stillMaking, setStillMaking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [playing, setPlaying] = useState<{ assetId: string | null; token: number }>({ assetId: null, token: 0 });
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const kit = q.data ?? null;
  const done = kit?.state === "done";
  const savedCaption = kit?.kit?.caption.text ?? "";
  const captionText = caption ?? savedCaption;
  const captionDirty = !done && caption !== null && caption !== savedCaption;
  const readClosed = q.isError && apiErrorOf(q.error).code === "closed";
  // The rendered preview, when ready: a reel's one video replaces its positions; a carousel's slides replace theirs.
  const previewState = usePreviewState(kit);
  const reel = renderedReel(kit);
  const slideFor = (assetId: string) => renderedSlide(kit, assetId);
  // One video plays at a time: the one she tapped, else the reel, else the kit's first clip (or rendered video slide).
  // The slots on screen: the reel's one, or each asset's.
  const slots = reel ? [PREVIEW_KEY] : kit?.kit?.assets.map((a) => a.assetId) ?? [];
  const slotKey = slots.join("|");
  const firstVideo = reel ? PREVIEW_KEY : kit?.kit?.assets.find((a) => (slideFor(a.assetId)?.kind ?? (a.mediaType === "clip" ? "video" : "image")) === "video")?.assetId ?? null;
  const activeAsset = playing.assetId ?? firstVideo;

  // A tapped slot that is no longer on screen (swapped out, or the raw clips replaced by the reel when the preview
  // lands) lets go, so the first video plays: the reel autoplays when it arrives and nothing else was chosen.
  useEffect(() => {
    if (playing.assetId && !slots.includes(playing.assetId)) setPlaying((p) => ({ assetId: null, token: p.token + 1 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slotKey is slots' identity
  }, [slotKey, playing.assetId]);

  // Done is read-only: an unsaved caption edit is dropped, the confirm step ends, the swap sheet closes.
  useEffect(() => {
    if (!done) return;
    setCaption(null); setConfirming(false); setSwapFor(null);
  }, [done]);
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const run = (w: PostKitWrite, after?: (r: PostKitWriteResult) => void) => {
    setFail(null); setNote(null);
    write.mutate(w, {
      onSuccess: (r) => after?.(r),
      onError: (err) => setFail(writeFailLine(w.op, err)),
    });
  };

  const onSwap = (replace: string, withId: string) => {
    if (!id) return;
    setSwapError(null);
    write.mutate({ op: "swap", id, replace, with: withId }, {
      onSuccess: () => { setSwapFor(null); haptics.success(); },
      onError: (err) => {
        // The kit moved elsewhere: close the sheet and show the fresh read with the reason. Anything else: say so in
        // the sheet and let her pick again.
        if (isStale(err)) { setSwapFor(null); setFail(writeFailLine("swap", err)); }
        else setSwapError(writeFailLine("swap", err));
      },
    });
  };
  const onSaveCaption = () => { if (id && caption !== null) run({ op: "caption", id, text: caption }, () => setCaption(null)); };
  // A build that made nothing (held, a cap, changed meanwhile) says why, under Build it.
  const onBuild = () => { if (id) run({ op: "build", id }, (r) => { if (!r.read.kit) setFail(buildOutcomeLine(r.outcome)); }); };
  // "Try again" on a stalled preview re-queues it (a new requestedAt, so polling restarts). If the answer is the same
  // stalled ask, say so rather than seem to ignore the tap.
  const onRetryPreview = () => {
    if (!id) return;
    setStillMaking(false);
    const before = kit;
    run({ op: "preview", id }, (r) => setStillMaking(retryChangedNothing(before, r.read)));
  };
  const onPosted = () => {
    if (!id || done) return;
    if (!confirming) {
      // The first tap only asks: a stray tap records nothing.
      setConfirming(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirming(false), CONFIRM_POSTED_MS);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirming(false);
    run({ op: "posted", id }, () => haptics.success());
  };
  // Share / Save copies the SAVED caption, so an unsaved edit is saved first; if that save fails, nothing is shared
  // (she'd otherwise get the old words) and the save's own reason shows. It always shares a FRESH read: the caption
  // save answers with one, and otherwise the kit is read again (signed URLs expire within the hour).
  const onShare = async () => {
    if (!id || !kit?.kit) return;
    setSaving(true); setNote(null); setFail(null);
    try {
      let current: PostKitResponse | null;
      if (captionDirty && caption !== null) {
        try {
          current = (await write.mutateAsync({ op: "caption", id, text: caption })).read;
          setCaption(null);
        } catch (err) {
          setFail(writeFailLine("caption", err));
          return;
        }
      } else {
        try { current = await freshKit(id); } catch { current = null; }
      }
      if (!current?.kit) { setFail(SHARE_COPY.failed); return; }
      const r = await sharePostKit(current);
      if ("note" in r) setNote(r.note); else setFail(r.fail);
    } finally {
      setSaving(false);
    }
  };

  const busy = write.isPending;
  const pendingOp = busy ? write.variables?.op : null;

  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title={POST_KIT_COPY.back} bold />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" testID="post-kit-screen">
        <Text style={styles.title} accessibilityRole="header">{POST_KIT_COPY.title}</Text>

        {q.isLoading ? (
          <View style={styles.center} testID="post-kit-loading"><ActivityIndicator color={Bold.ink} /></View>
        ) : readClosed ? (
          <View style={styles.center} testID="post-kit-closed">
            <Feather name="archive" size={22} color={Bold.quiet} />
            <Text style={styles.stateTitle}>{POST_KIT_COPY.closedTitle}</Text>
            <Text style={styles.muted}>{POST_KIT_COPY.closedLine}</Text>
          </View>
        ) : q.isError ? (
          <View style={styles.center} testID="post-kit-error">
            <Text style={styles.muted}>{POST_KIT_COPY.error}</Text>
            <Button bold="small" onPress={() => { void q.refetch(); }} testID="post-kit-retry">{POST_KIT_COPY.retry}</Button>
          </View>
        ) : !kit ? (
          <View style={styles.center} testID="post-kit-dark"><Text style={styles.muted}>{POST_KIT_COPY.error}</Text></View>
        ) : !kit.kit ? (
          <View style={styles.center} testID="post-kit-empty">
            <Feather name="film" size={22} color={Bold.quiet} />
            <Text style={styles.muted}>{busy && pendingOp === "build" ? POST_KIT_COPY.building : POST_KIT_COPY.noKit}</Text>
            <Button bold="primary" onPress={onBuild} loading={busy && pendingOp === "build"} style={styles.buildBtn} testID="post-kit-build">{POST_KIT_COPY.build}</Button>
            {fail ? <FailLine text={fail} testID="post-kit-fail" /> : null}
          </View>
        ) : (
          <>
            <IdeaCard kit={kit} />

            {kit.kit.assets.length === 0 ? (
              <Card bold style={styles.card} testID="post-kit-no-assets">
                <Text style={styles.body}>{POST_KIT_COPY.noAssets}</Text>
                {/* EXPO_PUBLIC_CAMERA_ROLL_INTAKE — the targeted ask: the review opens filtered for this post, and what
                    she picks comes straight back into this kit. */}
                {CAMERA_ROLL_INTAKE && Platform.OS !== "web" && id && kit.kit && kit.state !== "done" ? (
                  <Button bold="primary" style={styles.buildBtn} testID="post-kit-camera-roll"
                    onPress={() => nav.navigate("CameraRollReview", { ask: askForKit(id, kit.kit!.idea.format) })}>
                    {POST_KIT_COPY.checkCameraRoll(kit.kit.idea.format)}
                  </Button>
                ) : null}
              </Card>
            ) : reel ? (
              <ReelBlock
                kit={kit}
                reel={reel}
                active={activeAsset === PREVIEW_KEY}
                playable={playable}
                token={playing.token}
                editable={!done}
                onPlay={() => setPlaying((p) => ({ assetId: PREVIEW_KEY, token: p.token + 1 }))}
                onSwap={(assetId) => { setSwapError(null); setSwapFor(assetId); }}
              />
            ) : (
              kit.kit.assets.map((a) => (
                <AssetBlock
                  key={a.assetId}
                  kit={kit}
                  asset={a}
                  rendered={slideFor(a.assetId)}
                  active={a.assetId === activeAsset}
                  playable={playable}
                  token={playing.token}
                  editable={!done}
                  onPlay={() => setPlaying((p) => ({ assetId: a.assetId, token: p.token + 1 }))}
                  onSwap={() => { setSwapError(null); setSwapFor(a.assetId); }}
                />
              ))
            )}

            {kit.kit.assets.length > 0 ? (
              <PreviewLine state={previewState} canRetry={!done} busy={pendingOp === "preview"} onRetry={onRetryPreview} />
            ) : null}
            {stillMaking && previewState === "failed" ? (
              <Text style={styles.hint} accessibilityLiveRegion="polite" testID="post-kit-preview-still-making">{POST_KIT_COPY.previewStillMaking}</Text>
            ) : null}

            {kit.music && kit.music.choices.length > 0 ? (
              <MusicChoices
                music={kit.music}
                editable={!done}
                busy={pendingOp === "music"}
                active={playable}
                onUse={(track) => { if (id) run({ op: "music", id, track }, () => haptics.success()); }}
                // Hearing a track restarts the preview (muted, as it always plays) so the two run together.
                onListen={(on) => { if (on && firstVideo) setPlaying((p) => ({ assetId: firstVideo, token: p.token + 1 })); }}
              />
            ) : null}

            <Card bold style={styles.card}>
              <Eyebrow>{POST_KIT_COPY.caption}</Eyebrow>
              {done ? (
                <Text style={styles.captionRead} testID="post-kit-caption-text">{savedCaption}</Text>
              ) : (
                <TextInput
                  value={captionText}
                  onChangeText={(t) => setCaption(t)}
                  onFocus={() => setCaptionFocused(true)}
                  onBlur={() => setCaptionFocused(false)}
                  multiline
                  maxLength={POST_KIT_CAPTION_CHARS}
                  style={[styles.captionInput, captionFocused && styles.captionInputFocus]}
                  accessibilityLabel={POST_KIT_COPY.caption}
                  testID="post-kit-caption-input"
                />
              )}
              {captionDirty ? (
                <Button bold="small" onPress={onSaveCaption} disabled={busy} loading={pendingOp === "caption"} style={styles.saveBtn} testID="post-kit-caption-save">{POST_KIT_COPY.save}</Button>
              ) : null}
            </Card>

            {fail ? <View style={styles.gutter}><FailLine text={fail} testID="post-kit-fail" /></View> : null}
            {note ? <View style={styles.notice} accessibilityLiveRegion="polite" testID="post-kit-notice"><Text style={styles.noticeText}>{note}</Text></View> : null}

            <View style={styles.actions}>
              <Button
                bold="primary"
                onPress={onPosted}
                disabled={done || busy}
                loading={pendingOp === "posted"}
                icon={done ? <Feather name="check" size={16} color={Bold.onDark} /> : undefined}
                style={styles.actionBtn}
                testID="post-kit-posted"
              >
                {done ? POST_KIT_COPY.done : confirming ? POST_KIT_COPY.confirmPosted : POST_KIT_COPY.posted}
              </Button>
              <Button bold="secondary" onPress={onShare} disabled={saving || busy} loading={saving} style={styles.actionBtn} testID="post-kit-share">{POST_KIT_COPY.share}</Button>
            </View>
            {confirming ? <Text style={styles.hint} accessibilityLiveRegion="polite" testID="post-kit-confirm-line">{POST_KIT_COPY.confirmLine}</Text> : null}
            {done ? <Text style={styles.hint} testID="post-kit-done-line">{POST_KIT_COPY.doneLine}</Text> : null}
          </>
        )}
      </ScrollView>

      {kit?.kit && swapFor && !done ? (
        <SwapSheet kit={kit} assetId={swapFor} busy={pendingOp === "swap"} error={swapError} onPick={onSwap} onClose={() => { setSwapFor(null); setSwapError(null); }} />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Bold.paper },
  content: { paddingBottom: 48 },
  title: { ...BoldType.screenTitleSm, color: Bold.ink, paddingHorizontal: Bold.gutter, paddingTop: 4 },
  center: { alignItems: "center", gap: 10, paddingVertical: 48, paddingHorizontal: 24 },
  stateTitle: { ...BoldType.h4, color: Bold.ink, textAlign: "center" },
  muted: { ...BoldType.lede, color: Bold.mute, textAlign: "center" },
  buildBtn: { alignSelf: "stretch", marginTop: 6 },
  card: { marginHorizontal: Bold.gutter, marginTop: 16, padding: 14, gap: 8 },
  hook: { ...BoldType.goal, color: Bold.ink },
  body: { ...BoldType.body, color: Bold.ink2 },
  whyBlock: { marginTop: 8, gap: 6, borderTopWidth: 1, borderTopColor: Bold.line, paddingTop: 10 },
  momentLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  momentText: { ...BoldType.caption, color: Bold.mute, flex: 1 },
  goalText: { ...BoldType.caption, color: Bold.ink2 },
  assetBlock: { marginHorizontal: Bold.gutter, marginTop: 16, gap: 8 },
  swapBtn: { alignSelf: "flex-start" },
  partsBlock: { gap: 8, marginTop: 4 },
  part: { gap: 8, width: 96 },
  previewLine: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: Bold.gutter, marginTop: 12 },
  previewText: { ...BoldType.caption, color: Bold.mute, flex: 1 },
  previewTextInk: { color: Bold.ink },
  // DESIGN.md §11 Input: 48 high at least, corner 4, white, 1px line; focus 1.5px ink. 16px on web (no zoom-on-focus).
  captionInput: {
    ...BoldType.body, ...(Platform.OS === "web" ? { fontSize: BoldType.herWords.fontSize } : null),
    color: Bold.ink, minHeight: 96, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control,
    paddingHorizontal: 12, paddingVertical: 12, textAlignVertical: "top", backgroundColor: Bold.paper,
  },
  captionInputFocus: { borderWidth: 1.5, borderColor: Bold.ink, paddingHorizontal: 11.5, paddingVertical: 11.5 },
  captionRead: { ...BoldType.body, color: Bold.ink },
  saveBtn: { alignSelf: "flex-start" },
  gutter: { marginHorizontal: Bold.gutter, marginTop: 12 },
  failLine: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  failText: { ...BoldType.body, color: Bold.ink, flex: 1 },
  notice: { marginHorizontal: Bold.gutter, marginTop: 14, paddingVertical: 10, paddingHorizontal: 14, borderRadius: Bold.radius.control, backgroundColor: Bold.ink },
  noticeText: { ...BoldType.rowMeta, color: Bold.onDark },
  actions: { flexDirection: "row", gap: 12, marginHorizontal: Bold.gutter, marginTop: 20 },
  actionBtn: { flex: 1 },
  hint: { ...BoldType.caption, color: Bold.mute, marginHorizontal: Bold.gutter, marginTop: 8 },
  sheetBody: { gap: 12, paddingTop: 8 },
  swapRow: { gap: 10 },
  swapTile: { width: 96, height: 96, borderRadius: Bold.radius.control, overflow: "hidden", backgroundColor: Bold.ground },
  pressed: { transform: [{ scale: Bold.pressScale }] },
  busy: { opacity: 0.5 },
  swapClipBadge: { position: "absolute", top: 4, right: 4, width: 20, height: 20, borderRadius: Bold.radius.chip, backgroundColor: Bold.deck.counter, alignItems: "center", justifyContent: "center" },
});
