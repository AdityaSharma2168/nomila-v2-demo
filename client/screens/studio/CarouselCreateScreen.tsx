/**
 * CarouselCreateScreen — the brand post's Carousel (PR 9, Lane 4). One machinery, two doors: the chooser's
 * Carousel chip, and the compose popover's ad chip (the selected photo arrives as ref 1).
 *
 * Her references (1–3, library or upload; the source gate's copy shows on a tile it refuses), her
 * distribution (how many ads from each, three in all), CREATE → the ITEMIZED quote → her tap → the rows are
 * queued and she is free: the screen polls, the tab bar works, coming back with the batch id restores it.
 * Results in a 2×2 grid: full size, Download one (the keep), Discard, Download all (names its count), one
 * re-roll. Nothing enters her library until a download.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { StudioStackParamList } from "../../navigation/MainTabNavigator";
import { HapticPressable } from "../../components/HapticPressable";
import { STUDIO_IMAGE_EDIT } from "../../lib/flags";
import { AssetViewer } from "../../components/studio/AssetViewer";
import { StudioMediaPicker } from "../../components/studio/StudioMediaPicker";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import {
  pickFromCameraRoll,
  useUploadMedia,
} from "../../hooks/use-media-library";
import {
  useBatch,
  useBatchAcceptAll,
  useBatchQuote,
  useBatchReroll,
  useBatchRun,
  useEditAccept,
  useEditDiscard,
  useRecommendEdits,
  type BatchQuoteAnswer,
} from "../../hooks/use-studio-edits";
import { fileNameFor, saveRemoteAsset } from "../../lib/download-asset";
import {
  addRef,
  allSettled,
  batchBody,
  canCreate,
  candidatesOf,
  downloadAllLabel,
  MAX_CANDIDATES,
  MAX_INITIAL_CANDIDATES,
  removeRef,
  setVariations,
  totalVariations,
  type CarouselRef,
} from "./carouselLogic";
import { MOUNT_ORIGINS } from "./mediaPickerLogic";
import type { EditPresented } from "./editTypes";

type Nav = NativeStackNavigationProp<StudioStackParamList>;
type Route = RouteProp<StudioStackParamList, "StudioCarouselCreate">;

/**
 * THE DOOR IS SHUT WITH THE FLAG OFF (PR 10, R-1). Every hook below asks the edit routes, which answer 404
 * with the server's flag off — the recommend pass on mount before she taps anything. So with the client
 * flag off this screen mounts NONE of them: a closed door and the way back, no request of any kind.
 * ⚠️ MUTATION (CarouselCreateScreen.test): render CarouselCreateOpen regardless — "Create screen fires a
 * request with the flag off" reds by name.
 */
export function CarouselCreateScreen() {
  const nav = useNavigation<Nav>();
  if (STUDIO_IMAGE_EDIT) return <CarouselCreateOpen />;
  return (
    <SafeAreaView style={styles.safe} testID="carousel-closed">
      <StatusBar barStyle="dark-content" />
      <View style={styles.topbar}>
        <HapticPressable
          onPress={() => nav.goBack()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={22} color={Colors.light.text} />
        </HapticPressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.topTitle}>Carousel</Text>
        </View>
      </View>
      <View style={styles.body}>
        <Text style={styles.hint}>
          Ads from your photos aren&apos;t available yet. Nothing was started.
        </Text>
      </View>
    </SafeAreaView>
  );
}

function CarouselCreateOpen() {
  const nav = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const [brand, setBrand] = useState(params?.brand ?? "");
  const [setting, setSetting] = useState("");
  const [refs, setRefs] = useState<CarouselRef[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [quote, setQuote] = useState<BatchQuoteAnswer | null>(null);
  const [batchId, setBatchId] = useState<string | null>(
    params?.batchId ?? null,
  );
  const [viewing, setViewing] = useState<EditPresented | null>(null);
  const [error, setError] = useState<string | null>(null);
  const briefLines = useMemo(() => params?.briefLines ?? [], [params]);
  const campaign = params?.campaign ?? null;

  const quoteM = useBatchQuote();
  const runM = useBatchRun();
  const rerollM = useBatchReroll();
  const acceptAllM = useBatchAcceptAll();
  const acceptM = useEditAccept();
  const discardM = useEditDiscard();
  const uploader = useUploadMedia();
  const batch = useBatch(batchId);

  // The three reference slots each ask the recommendation pass once (the popover's pass, the same memo).
  const r0 = useRecommendEdits(
    refs[0]?.assetId ?? null,
    briefLines,
    brand || null,
  );
  const r1 = useRecommendEdits(
    refs[1]?.assetId ?? null,
    briefLines,
    brand || null,
  );
  const r2 = useRecommendEdits(
    refs[2]?.assetId ?? null,
    briefLines,
    brand || null,
  );
  const answers = [r0, r1, r2];
  useEffect(() => {
    setRefs((l) =>
      l.map((r, i) => {
        const a = answers[i]?.data;
        if (!a) return r;
        const cleanup = a.recs[0] ?? null;
        const refusal = a.refusal ?? null;
        return r.cleanup === cleanup && r.refusal === refusal
          ? r
          : { ...r, cleanup, refusal };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r0.data, r1.data, r2.data]);

  // The popover's door: the selected photo as ref 1.
  useEffect(() => {
    const first = params?.refs?.[0];
    if (first && refs.length === 0) {
      const out = addRef([], {
        assetId: first,
        thumbUrl: params?.thumbs?.[first] ?? null,
      });
      if (out.ok) {
        const three = setVariations(out.refs, first, MAX_INITIAL_CANDIDATES);
        setRefs(three.ok ? three.refs : out.refs);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ONE photo, THREE ads — Adi's shape (23 Sep 2026): the first photo takes all three variations. The
  // engine still takes up to three photos; this screen offers one, and "Change photo" swaps it.
  const add = (photo: { assetId: string; thumbUrl: string | null }) => {
    const out = addRef([], photo);
    if (!out.ok) {
      setNote(out.reason);
      return;
    }
    const three = setVariations(
      out.refs,
      photo.assetId,
      MAX_INITIAL_CANDIDATES,
    );
    setNote(null);
    setRefs(three.ok ? three.refs : out.refs);
  };
  const onUpload = async () => {
    const picked = await pickFromCameraRoll("photo");
    if (!picked || !("asset" in picked) || !picked.asset) return;
    try {
      const item = await uploader.mutateAsync({
        asset: picked.asset as never,
        ackRights: true,
      });
      add({ assetId: item.asset_id, thumbUrl: item.thumb_url ?? item.url });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't upload that.");
    }
  };

  const onQuote = async () => {
    setError(null);
    try {
      const q = await quoteM.mutateAsync(
        batchBody(
          refs,
          brand.trim(),
          campaign,
          briefLines,
          null,
          setting.trim(),
        ),
      );
      setQuote(q);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't price that.");
    }
  };
  const onCreate = async () => {
    if (!quote) return;
    setError(null);
    try {
      await runM.mutateAsync({ batchId: quote.batchId });
      setBatchId(quote.batchId);
      setQuote(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start that.");
    }
  };
  const download = async (c: EditPresented) => {
    setError(null);
    try {
      const out = await acceptM.mutateAsync({ id: c.id });
      if (c.url) await saveRemoteAsset(c.url, fileNameFor(c.url, out.assetId));
      batch.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't keep that.");
    }
  };
  const downloadAll = async () => {
    if (!batchId) return;
    setError(null);
    try {
      const ready = candidatesOf(batch.data?.candidates ?? []).filter(
        (c) => c.status === "ready",
      );
      const out = await acceptAllM.mutateAsync({ batchId });
      for (const [i, c] of ready.entries()) {
        const assetId = out.assetIds[i];
        if (c.url && assetId)
          await saveRemoteAsset(c.url, fileNameFor(c.url, assetId));
      }
      batch.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't keep those.");
    }
  };
  const discard = async (c: EditPresented) => {
    await discardM.mutateAsync({ id: c.id }).catch(() => undefined);
    batch.refetch();
  };
  const reroll = async (c: EditPresented) => {
    if (!batchId) return;
    setError(null);
    try {
      const q = await rerollM.mutateAsync({
        batchId,
        assetId: c.sourceAssetId,
      });
      await runM.mutateAsync({ batchId });
      setNote(
        q.costUsd === null
          ? "Priced as unknown — it did not run."
          : `One more · $${q.costUsd.toFixed(2)}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't make one more.");
    }
  };

  const candidates = candidatesOf(batch.data?.candidates ?? []);
  // Every poll re-signs every url, and a new uri makes <Image> reload — the flicker. The FIRST url seen for a
  // row is the one drawn from then on (a signed url outlives the session by a wide margin).
  const urls = useRef(new Map<string, string>());
  for (const c of candidates)
    if (c.url && !urls.current.has(c.id)) urls.current.set(c.id, c.url);
  const urlOf = (c: EditPresented) => urls.current.get(c.id) ?? c.url;
  const settled = allSettled(candidates);
  const expected = Math.max(candidates.length, MAX_INITIAL_CANDIDATES);
  const readyCount = candidates.filter((c) => c.status === "ready").length;
  const busy =
    quoteM.isPending ||
    runM.isPending ||
    acceptM.isPending ||
    acceptAllM.isPending ||
    rerollM.isPending;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.topbar}>
        <HapticPressable
          onPress={() => nav.goBack()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={22} color={Colors.light.text} />
        </HapticPressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.topTitle}>Carousel</Text>
          <Text style={styles.topSub}>
            {brand ? `An ad for ${brand}` : "An ad, from your photos"}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {!batchId ? (
          <>
            <Text style={styles.label}>THE BRAND</Text>
            <TextInput
              style={styles.input}
              value={brand}
              onChangeText={setBrand}
              placeholder="Who is this for?"
              placeholderTextColor={Colors.light.textMuted}
              accessibilityLabel="The brand"
            />

            <Text style={styles.label}>YOUR PHOTO</Text>
            <Text style={styles.hint}>
              One photo of yours. You get {MAX_INITIAL_CANDIDATES} ads from it
              {brand ? ` for ${brand}` : ""} — then one extra if you want it.
            </Text>
            {refs.length ? (
              <View style={styles.refs}>
                {refs.map((r, i) => (
                  <View
                    key={r.assetId}
                    style={styles.ref}
                    testID="carousel-ref"
                  >
                    {r.thumbUrl ? (
                      <Image
                        source={{ uri: r.thumbUrl }}
                        style={styles.refImg}
                      />
                    ) : (
                      <View style={[styles.refImg, styles.blank]} />
                    )}
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={styles.refTitle}>Photo {i + 1}</Text>
                      {r.refusal ? (
                        <Text style={styles.refusalTxt}>{r.refusal}</Text>
                      ) : (
                        <>
                          <Text style={styles.hint}>
                            {r.variations} {r.variations === 1 ? "ad" : "ads"}{" "}
                            from this photo
                          </Text>
                          {r.cleanup ? (
                            <Text style={styles.cleanup}>
                              Cleaned first: {r.cleanup.what} — “
                              {r.cleanup.because}”
                            </Text>
                          ) : answers[i]?.isFetching ? (
                            <Text style={styles.hint}>
                              Checking it against the brief…
                            </Text>
                          ) : null}
                        </>
                      )}
                    </View>
                    <Pressable
                      onPress={() => setRefs(removeRef(refs, r.assetId))}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove photo ${i + 1}`}
                    >
                      <Feather
                        name="x"
                        size={16}
                        color={Colors.light.textMuted}
                      />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
            {refs.length === 0 ? (
              <>
                <StudioMediaPicker
                  kind="photos"
                  origins={MOUNT_ORIGINS["agent-pick"]}
                  context="agent-pick"
                  selectedIds={refs.map((r) => r.assetId)}
                  label="Use this photo"
                  onPick={(row) => {
                    if (row.kind === "photo")
                      add({ assetId: row.assetId, thumbUrl: row.thumbUrl });
                  }}
                  renderTile={(row, t) => (
                    <Pressable
                      onPress={t.onPress}
                      style={[styles.tile, t.mark !== null && styles.tileOn]}
                      accessibilityRole="button"
                      accessibilityLabel="Use this photo"
                      accessibilityState={{ selected: t.mark !== null }}
                    >
                      <Image
                        source={{
                          uri:
                            (row.kind === "photo"
                              ? row.thumbUrl
                              : row.posterUrl) ?? undefined,
                        }}
                        style={styles.tileImg}
                      />
                    </Pressable>
                  )}
                />
                <Pressable
                  style={styles.secondary}
                  onPress={onUpload}
                  disabled={uploader.isPending}
                  accessibilityRole="button"
                  accessibilityLabel="Upload a photo"
                >
                  <Text style={styles.secondaryTxt}>
                    {uploader.isPending ? "Uploading…" : "Upload a photo"}
                  </Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                style={styles.secondary}
                onPress={() => setRefs([])}
                accessibilityRole="button"
                accessibilityLabel="Change photo"
              >
                <Text style={styles.secondaryTxt}>Change photo</Text>
              </Pressable>
            )}
            {note ? <Text style={styles.note}>{note}</Text> : null}

            <Text style={styles.label}>THE SETTING</Text>
            <TextInput
              style={styles.input}
              value={setting}
              onChangeText={(v) => setSetting(v.slice(0, 40))}
              placeholder="stadium pitch at dusk — where the first ad is set"
              placeholderTextColor={Colors.light.textMuted}
              accessibilityLabel="The setting"
            />

            {quote ? (
              <View style={styles.card} testID="carousel-quote">
                <Text style={styles.label}>THE PRICE</Text>
                {quote.lines.map((l, i) => (
                  <View key={l.assetId} style={{ gap: 2 }}>
                    <Text style={styles.line}>Photo {i + 1}</Text>
                    {l.cleanup ? (
                      <Text style={styles.hint}>
                        · clean-up first ({l.cleanup.op}) · $
                        {(l.cleanup.costUsd ?? 0).toFixed(2)}
                      </Text>
                    ) : null}
                    <Text style={styles.hint}>
                      · {l.ads.length} {l.ads.length === 1 ? "ad" : "ads"} · $
                      {l.ads
                        .reduce((s, a) => s + (a.costUsd ?? 0), 0)
                        .toFixed(2)}
                    </Text>
                  </View>
                ))}
                <Text style={styles.price}>
                  {quote.unpriced
                    ? "Price unknown — this can't run."
                    : `$${quote.totalUsd.toFixed(2)} in all`}
                </Text>
                <Pressable
                  style={[
                    styles.cta,
                    (busy || quote.unpriced) && styles.ctaOff,
                  ]}
                  disabled={busy || quote.unpriced}
                  onPress={onCreate}
                  accessibilityRole="button"
                  accessibilityLabel={`Create for $${quote.totalUsd.toFixed(2)}`}
                  testID="carousel-create"
                >
                  {runM.isPending ? (
                    <ActivityIndicator color={Colors.light.buttonText} />
                  ) : (
                    <Text style={styles.ctaTxt}>
                      Create · ${quote.totalUsd.toFixed(2)}
                    </Text>
                  )}
                </Pressable>
                <Text style={styles.hint}>
                  Nothing is charged until you tap. It runs in the background —
                  you can leave this screen.
                </Text>
              </View>
            ) : (
              <Pressable
                style={[
                  styles.cta,
                  (!canCreate(refs) ||
                    !brand.trim() ||
                    !setting.trim() ||
                    busy) &&
                    styles.ctaOff,
                ]}
                disabled={
                  !canCreate(refs) || !brand.trim() || !setting.trim() || busy
                }
                onPress={onQuote}
                accessibilityRole="button"
                accessibilityLabel="See the price"
                testID="carousel-quote-cta"
              >
                {quoteM.isPending ? (
                  <ActivityIndicator color={Colors.light.buttonText} />
                ) : (
                  <Text style={styles.ctaTxt}>
                    See the price · {totalVariations(refs)}{" "}
                    {totalVariations(refs) === 1 ? "ad" : "ads"}
                  </Text>
                )}
              </Pressable>
            )}
          </>
        ) : (
          <>
            <Text style={styles.label}>
              {batch.data?.running
                ? "MAKING…"
                : `YOUR ${candidates.length === 1 ? "AD" : "ADS"}`}
            </Text>
            {batch.data?.running ? (
              <Text style={styles.hint}>
                Working in the background. You can leave — nothing will tell
                you; when it is done, it waits as a row under Now on the Studio
                tab, and that row opens this screen.
              </Text>
            ) : null}
            <View style={styles.grid} testID="carousel-grid">
              {!settled
                ? Array.from({ length: expected }, (_, i) => (
                    <View
                      key={`slot-${i}`}
                      style={styles.cell}
                      testID="carousel-slot"
                    >
                      <View style={[styles.cellImg, styles.blank]}>
                        <ActivityIndicator color={Colors.light.primary} />
                      </View>
                    </View>
                  ))
                : candidates.map((c) => (
                    <View
                      key={c.id}
                      style={[
                        styles.cell,
                        c.status === "discarded" && styles.cellOff,
                      ]}
                      testID={`carousel-candidate-${c.status}`}
                    >
                      <Pressable
                        onPress={() =>
                          urlOf(c) && setViewing({ ...c, url: urlOf(c) })
                        }
                        accessibilityRole="button"
                        accessibilityLabel={
                          c.status === "ready" ? "View full size" : c.status
                        }
                      >
                        {urlOf(c) ? (
                          <Image
                            source={{ uri: urlOf(c)! }}
                            style={styles.cellImg}
                          />
                        ) : (
                          <View style={[styles.cellImg, styles.blank]}>
                            <Text style={styles.hint}>{c.status}</Text>
                          </View>
                        )}
                      </Pressable>
                      {c.status === "ready" ? (
                        <View style={styles.cellActions}>
                          <Pressable
                            onPress={() => download(c)}
                            disabled={busy}
                            accessibilityRole="button"
                            accessibilityLabel="Download this frame"
                            testID="carousel-download"
                          >
                            <Feather
                              name="download"
                              size={16}
                              color={Colors.light.primary}
                            />
                          </Pressable>
                          <Pressable
                            onPress={() => discard(c)}
                            disabled={busy}
                            accessibilityRole="button"
                            accessibilityLabel="Discard this frame"
                            testID="carousel-discard"
                          >
                            <Feather
                              name="trash-2"
                              size={16}
                              color={Colors.light.textMuted}
                            />
                          </Pressable>
                        </View>
                      ) : c.status === "accepted" ? (
                        <Text style={styles.kept}>Saved</Text>
                      ) : c.status === "failed" ? (
                        <Text style={styles.refusalTxt}>
                          {c.error ?? "Didn't come out."}
                        </Text>
                      ) : null}
                    </View>
                  ))}
            </View>
            {settled && readyCount > 0 ? (
              <Pressable
                style={[styles.cta, busy && styles.ctaOff]}
                disabled={busy}
                onPress={downloadAll}
                accessibilityRole="button"
                accessibilityLabel={downloadAllLabel(readyCount)}
                testID="carousel-download-all"
              >
                <Text style={styles.ctaTxt}>
                  {downloadAllLabel(readyCount)}
                </Text>
              </Pressable>
            ) : null}
            {settled &&
            batch.data?.canReroll &&
            !batch.data.running &&
            candidates.length < MAX_CANDIDATES ? (
              <Pressable
                style={styles.secondary}
                disabled={busy}
                onPress={() => reroll(candidates[0])}
                accessibilityRole="button"
                accessibilityLabel="Make one more"
                testID="carousel-reroll"
              >
                <Text style={styles.secondaryTxt}>
                  Make one more (priced again)
                </Text>
              </Pressable>
            ) : null}
            {note ? <Text style={styles.note}>{note}</Text> : null}
          </>
        )}

        {error ? (
          <View style={styles.refusal}>
            <Feather
              name="alert-circle"
              size={13}
              color={Colors.light.primary}
            />
            <Text style={styles.refusalTxt}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>

      <AssetViewer
        visible={!!viewing}
        uri={viewing?.url ?? null}
        assetId={viewing?.acceptedAssetId ?? null}
        title={brand ? `An ad for ${brand}` : "Your ad"}
        onClose={() => setViewing(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.border,
  },
  topTitle: {
    fontFamily: Fonts.bodyBold,
    fontSize: 16,
    fontWeight: "700",
    color: Colors.light.text,
  },
  topSub: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textMuted,
  },
  body: { padding: Spacing.lg, gap: Spacing.sm, paddingBottom: 48 },
  label: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: Colors.light.textMuted,
    marginTop: Spacing.sm,
  },
  hint: {
    fontFamily: Fonts.body,
    fontSize: 11.5,
    lineHeight: 16,
    color: Colors.light.textMuted,
  },
  note: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12,
    fontWeight: "600",
    color: Colors.light.primary,
  },
  input: {
    fontFamily: Fonts.body,
    fontSize: 14,
    color: Colors.light.text,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    backgroundColor: Colors.light.card,
  },
  refs: { gap: Spacing.sm },
  ref: {
    flexDirection: "row",
    gap: Spacing.sm,
    alignItems: "flex-start",
    padding: Spacing.sm,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.card,
  },
  refImg: { width: 56, height: 76, borderRadius: BorderRadius.md },
  blank: {
    backgroundColor: Colors.light.backgroundSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  refTitle: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.light.text,
  },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6 },
  chip: {
    minWidth: 34,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.light.border,
    alignItems: "center",
  },
  chipOn: {
    backgroundColor: Colors.light.text,
    borderColor: Colors.light.text,
  },
  chipTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12,
    fontWeight: "600",
    color: Colors.light.text,
  },
  chipTxtOn: { color: Colors.light.buttonText },
  cleanup: {
    fontFamily: Fonts.body,
    fontSize: 11.5,
    lineHeight: 16,
    color: Colors.light.text,
  },
  tile: {
    width: 56,
    height: 76,
    borderRadius: BorderRadius.md,
    overflow: "hidden",
    marginRight: 8,
    borderWidth: 2,
    borderColor: "transparent",
  },
  tileOn: { borderColor: Colors.light.primary },
  tileImg: { width: 56, height: 76 },
  card: {
    marginTop: Spacing.sm,
    padding: Spacing.md,
    gap: Spacing.sm,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.card,
  },
  line: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.light.text,
  },
  price: {
    fontFamily: Fonts.bodyBold,
    fontSize: 15,
    fontWeight: "700",
    color: Colors.light.text,
  },
  cta: {
    marginTop: Spacing.sm,
    backgroundColor: Colors.light.text,
    borderRadius: BorderRadius.full,
    paddingVertical: 12,
    alignItems: "center",
  },
  ctaOff: { opacity: 0.5 },
  ctaTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
    fontWeight: "600",
    color: Colors.light.buttonText,
  },
  secondary: { paddingVertical: 10, alignItems: "center" },
  secondaryTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.light.primary,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.sm,
    justifyContent: "flex-start",
  },
  cell: { width: "31%", gap: 6 },
  cellOff: { opacity: 0.4 },
  cellImg: {
    width: "100%",
    aspectRatio: 3 / 4,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.card,
  },
  cellActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 6,
  },
  kept: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12,
    fontWeight: "600",
    color: Colors.light.primary,
    paddingHorizontal: 6,
  },
  refusal: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: Spacing.sm,
  },
  refusalTxt: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: Colors.light.text,
  },
});
