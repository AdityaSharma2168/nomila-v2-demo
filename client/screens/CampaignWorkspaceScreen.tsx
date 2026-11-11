import React, { useMemo, useState } from "react";
import {
  View, Text, ScrollView, SafeAreaView, StatusBar, Pressable, StyleSheet, TextInput, Image,
  ActivityIndicator,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { StudioStackParamList } from "../navigation/MainTabNavigator";
import { useAuth } from "../lib/auth-context";
import { useAthleteBrands } from "../hooks/use-card";
import { useMyMedia } from "../hooks/use-media-library";
import {
  DELIVERABLES_FOR, usePreviewGeneration, useGenerate, useClearance, StudioUnavailable,
  type GeneratedAsset, type StudioDeliverable, type StudioIntent, type StudioObjective,
} from "../hooks/use-studio";
import { GenerationResult } from "../components/studio/GenerationResult";
import { MaskEditor, toStudioRegions, type DraftRegion } from "../components/studio/MaskEditor";
import { STUDIO_IDENTITY_PACK } from "../lib/flags";
import {
  ReferencePicker, toStudioReferences, hasUntagged, type DraftReference,
} from "../components/studio/ReferencePicker";
import { PitchAvatar } from "../components/pitch/PitchAvatar";
import { Bold, BorderRadius, Brand, Colors, Fonts, Spacing } from "../constants/theme";

/**
 * CampaignWorkspaceScreen — the ONE room every Studio intent opens into.
 *
 * The intent picker chose the ENGINE and the MODE before we got here (`route.params.intent`), and
 * that fork is the only thing this screen does not let you change: an edit and a generate are
 * different primitives, not one path with a toggle. Everything else — format, brand, goal, the
 * brief itself — is a PARAMETER, edited in place. There is no second workspace for "ad" or "story";
 * those are pills.
 *
 * WHAT IT DOES: composes a brief and asks the server what would happen. The pre-check makes no
 * model call and spends nothing — it returns the route, the reference count, an ESTIMATED cost and
 * any blockers, all derived without running anything.
 *
 * WHAT GENERATE SENDS: the previewId of the check she just read, and nothing else. Not the cost,
 * not a ceiling, not an "I approved it" flag — the server holds its own record of the figure it
 * showed her and reads the ceiling off that. There is deliberately nothing here to get wrong, and
 * nothing a modified client could inflate.
 *
 * A stale check cannot spend either: change the format, the goal, the brand or the brief and the
 * approval is dropped, because the thing she agreed to a price for is no longer the thing that
 * would run. She re-checks, which costs nothing.
 */

type Nav = NativeStackNavigationProp<StudioStackParamList>;
type WorkspaceRoute = RouteProp<StudioStackParamList, "CampaignWorkspace">;
type IconName = React.ComponentProps<typeof Feather>["name"];

const INTENTS: Record<StudioIntent, { title: string; label: string; blurb: string; icon: IconName }> = {
  "image.generate": { title: "New image",    label: "New image",    blurb: "A still made from scratch, cast from who you are.", icon: "image" },
  "image.edit":     { title: "Edit a photo", label: "Edit a photo", blurb: "Change one thing in a shot you already own.",      icon: "crop" },
  "video.generate": { title: "New video",    label: "New video",    blurb: "A few seconds of motion.",                         icon: "video" },
};

const DELIVERABLE_LABEL: Record<StudioDeliverable, string> = {
  post: "Post", story: "Story", reel: "Reel", carousel: "Carousel", ad: "Ad", clip: "Clip",
};

/** Her goal for the piece. Drives brand tailoring and the fallback direction when the brief is blank. */
const OBJECTIVES: { value: StudioObjective; label: string; needsBrand?: boolean }[] = [
  { value: "grow-following",   label: "Grow my audience" },
  { value: "showcase-product", label: "Show a product",      needsBrand: true },
  { value: "announce",         label: "Announce a deal",     needsBrand: true },
  { value: "recap",            label: "Recap a moment" },
  { value: "thank-partner",    label: "Thank a partner",     needsBrand: true },
  { value: "concept",          label: "Just ideas" },
];

export function CampaignWorkspaceScreen() {
  const nav = useNavigation<Nav>();
  const route = useRoute<WorkspaceRoute>();
  const { athlete } = useAuth();
  const { brands } = useAthleteBrands(athlete?.id);

  const intent = route.params?.intent ?? "image.generate";
  const spec = INTENTS[intent];
  const formats = DELIVERABLES_FOR[intent];

  const [deliverable, setDeliverable] = useState<StudioDeliverable>(
    route.params?.deliverable && formats.includes(route.params.deliverable)
      ? route.params.deliverable
      : formats[0],
  );
  const [sourceAssetId, setSourceAssetId] = useState<string | undefined>(route.params?.sourceAssetId);
  // The signed url of the chosen frame, held only so the mask editor can render it. Geometry is
  // never derived from it here — see MaskEditor's header.
  //
  // IT IS ONLY SET BY PICKING, which is the one way to reach an edit today. `route.params
  // .sourceAssetId` exists for the generate-to-edit handoff that is not built yet; whoever wires
  // that up has to supply the url alongside the id (or resolve it from the id) or the mask stage
  // will render empty under a photo that looks selected.
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [regions, setRegions] = useState<DraftRegion[]>([]);
  /**
   * The tagged references this piece is built from — the core input on BOTH arms.
   *
   * A generate has no frame, so these are the whole anchor. An edit has one, and then the base is
   * WHAT is changing while these are what to change it toward. Same state either way; only the
   * copy above the picker differs.
   */
  const [references, setReferences] = useState<DraftReference[]>([]);
  // "Just these" (PR 17): her word that the pack may not top up her likeness slots. Session-only.
  const [justThese, setJustThese] = useState(false);
  const [direction, setDirection] = useState("");

  const brand = useMemo(
    () => brands.find((b) => b.brandId === route.params?.brandId) ?? null,
    [brands, route.params?.brandId],
  );

  const [objective, setObjective] = useState<StudioObjective>(brand ? "showcase-product" : "grow-following");

  const preview = usePreviewGeneration();
  const gen = useGenerate();
  const clearance = useClearance();
  const result = preview.data ?? null;

  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [runNote, setRunNote] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const needsSource = intent === "image.edit";
  // An edit needs a photo AND at least one labelled box. The server enforces both — this only
  // keeps her from spending a round trip to be told something the screen already knows.
  const labelledRegions = regions.filter((r) => r.label.trim().length > 0);
  // An untagged reference is the same shape of "not finished yet": the server refuses one (there is
  // deliberately no default role), so holding the check back is honesty rather than an extra rule.
  const untaggedRefs = hasUntagged(references);
  const canCheck =
    !untaggedRefs &&
    (!needsSource || (!!sourceAssetId && labelledRegions.length === regions.length && regions.length > 0));

  /**
   * Any edit to the brief invalidates the check.
   *
   * The server would refuse a stale approval anyway — it re-derives the quote and compares it to
   * what she agreed to. Dropping it here is about honesty rather than safety: leaving a Generate
   * button live under a cost line that no longer describes the job invites her to buy something
   * she was not quoted for.
   */
  const invalidate = () => {
    if (preview.data || preview.error) preview.reset();
    setAssets([]); setRunNote(null); setRunError(null);
  };

  // quality-scrappy piece 5: the last request she checked, kept so a Try again on a failed output re-checks THAT job
  // with the gate's fix — her inputs are cleared after a success (clearComposition), and the job is not her next one.
  const [lastRequest, setLastRequest] = useState<Parameters<typeof preview.mutate>[0] | null>(null);
  const tryAgain = (corrective: string[]) => {
    if (!lastRequest) return;
    setRunNote(null); setRunError(null);
    preview.mutate({ ...lastRequest, corrective });
  };

  const runCheck = () => {
    setAssets([]); setRunNote(null); setRunError(null);
    const vars: Parameters<typeof preview.mutate>[0] = {
      intent,
      deliverable,
      objective,
      direction: direction.trim() || undefined,
      brandId: brand?.brandId ?? null,
      sourceAssetId,
      // Fractions, straight from the boxes she drew. The server maps them into the original frame.
      ...(needsSource && regions.length ? { regions: toStudioRegions(regions) } : {}),
      // Asset ids and tags only — never a path. The server re-reads each row under her own athlete
      // id and takes the storage path from there.
      ...(references.length ? { references: toStudioReferences(references) } : {}),
      // Only with the flag on does the policy ride; off, this object is exactly what it was.
      ...(STUDIO_IDENTITY_PACK && justThese ? { packPolicy: "just-these" as const } : {}),
    };
    setLastRequest(vars);
    preview.mutate(vars);
  };

  /**
   * Everything the NEXT piece must not inherit.
   *
   * This screen does not unmount between pieces — she generates, looks at it, and starts the next
   * one in the same room. Without this the composition simply stayed: the frame, the boxes drawn on
   * it, the tagged references and her written brief all rode into the next job unless she noticed
   * and cleared them by hand. That is how a likeness tagged for one piece ended up conditioning an
   * edit of a completely different photograph.
   *
   * ONLY ON SUCCESS. A failed run leaves every input exactly where it was, because the next thing
   * she does is press the button again — clearing the composition out from under a failure would
   * make her rebuild the job that just did not run.
   *
   * The RESULT is deliberately not cleared. The piece stays on screen; it is the inputs that are
   * spent. `preview.reset()` drops the consumed approval with them, so the next Check is a real
   * check rather than a live button under a cost line describing work that already happened.
   */
  const clearComposition = () => {
    setReferences([]);
    setRegions([]);
    setSourceAssetId(undefined);
    setSourceUrl(null);
    setDirection("");
    preview.reset();
  };

  const runGenerate = async () => {
    if (!result?.previewId) return;
    setRunNote(null); setRunError(null);
    try {
      // previewId only. See the module header.
      const run = await gen.mutateAsync({ previewId: result.previewId });
      setAssets(run.assets);
      clearComposition();
      if (run.status === "already_running") {
        // A second tap on the same check. The first one owns the spend — and may still be running,
        // in which case there is genuinely nothing to show yet. Say which, rather than showing an
        // empty result under "here it is".
        setRunNote(run.assets.length
          ? "You'd already made this one — here it is."
          : "Already running from your first tap. It'll appear here when it lands.");
      }
    } catch (e) {
      setRunError(
        e instanceof StudioUnavailable
          ? e.message
          : e instanceof Error ? e.message : "Couldn't generate that.",
      );
    }
  };

  const decide = async (assetId: string, action: "approve" | "reject" | "reopen") => {
    setRunNote(null); setRunError(null);
    try {
      const out = await clearance.mutateAsync({ assetId, action });
      setAssets((prev) => prev.map((a) =>
        a.assetId === out.assetId ? { ...a, approvalStatus: out.approvalStatus, allowedNext: out.allowedNext } : a));
      if (out.message) setRunNote(out.message);
    } catch (e) {
      // Whatever this is, it is already a sentence for a person — the server never forwards a
      // database refusal.
      setRunError(e instanceof Error ? e.message : "Couldn't do that right now.");
    }
  };

  const canGenerate = !!result?.verdict.canGenerate && !!result.previewId && !gen.isPending;

  const athleteName = [athlete?.firstName, athlete?.lastName].filter(Boolean).join(" ") || "Your profile";
  const athleteMeta = [athlete?.sport, athlete?.school].filter(Boolean).join(" · ");

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.topbar}>
        <Pressable style={styles.backBtn} onPress={() => nav.goBack()} hitSlop={8}>
          <Feather name="arrow-left" size={20} color={Colors.light.text} />
        </Pressable>
        <Text style={styles.topbarTitle}>{spec.title}</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 48 }} showsVerticalScrollIndicator={false}>
        {/* ── What this is (the fork — set by the picker, not editable here) ── */}
        <View style={styles.section}>
          <Text style={styles.eyebrow}>WHAT THIS IS</Text>
          <View style={styles.objCard}>
            <View style={styles.objIcon}>
              <Feather name={spec.icon} size={18} color={Colors.light.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.objLabel}>{spec.label}</Text>
              <Text style={styles.objBlurb}>{spec.blurb}</Text>
            </View>
          </View>
        </View>

        {/* ── Format: a parameter, not a branch ── */}
        <View style={styles.section}>
          <Text style={styles.eyebrow}>FORMAT</Text>
          <View style={styles.pillRow}>
            {formats.map((f) => (
              <Pill key={f} label={DELIVERABLE_LABEL[f]} active={f === deliverable} onPress={() => { setDeliverable(f); invalidate(); }} />
            ))}
          </View>
        </View>

        {/* ── The frame to preserve, and the part of it to change (edit only) ── */}
        {needsSource ? (
          <>
            <SourcePicker
              selected={sourceAssetId}
              onSelect={(id, url) => {
                // A different photo makes the old boxes meaningless — they were fractions OF THE
                // OTHER FRAME. Dropping them is the only honest move; carrying them over would put
                // a mask somewhere she never drew one.
                if (id !== sourceAssetId) setRegions([]);
                setSourceAssetId(id);
                setSourceUrl(url);
                invalidate();
              }}
            />
            <MaskEditor
              imageUrl={sourceAssetId ? sourceUrl : null}
              regions={regions}
              onChange={(next) => { setRegions(next); invalidate(); }}
            />
          </>
        ) : null}

        {/* What it's built FROM. On an edit this sits after the mask so the reading order matches
            the sentence: this is the photo, this is the part to change, this is what to change it
            toward. On a generate it is the first real input on the screen.

            ─── ⚠️  THE VIDEO ARM RENDERS THIS TOO, AND USED NOT TO ──────────────────────────────
            It was hidden on `video.generate` from the day the picker landed (#312), which left "New
            video" as the one door in the app that could not be given a photograph. That is not a
            missing nicety: `shotTypeFor` derives the shot from the references, so a clip with none is
            b-roll — and b-roll routes to seedance, which refuses real-person image-to-video 6/6 by
            stated BytePlus policy. The only clip this screen could make was therefore one she is not
            in, whatever she typed. With a photo tagged "You" it is an `identity` shot on Veo, which
            has always done image-to-video correctly.

            No engine change comes with this. The task follows from the intent and always did; the
            references were simply never collected. `clip` changes the picker's COPY alone — a still
            is built from a pack and a clip from one frame (see referencePack.ts). */}
        <ReferencePicker
          references={references}
          onChange={(next) => { setReferences(next); invalidate(); }}
          clip={intent === "video.generate"}
          // The "just these" toggle exists only in a build with the pack flag on (PR 17).
          {...(STUDIO_IDENTITY_PACK && intent === "image.generate"
            ? { justThese, onJustThese: (v: boolean) => { setJustThese(v); invalidate(); } }
            : {})}
        />

        {/* ── Who it's for ── */}
        <View style={styles.section}>
          <Text style={styles.eyebrow}>WHO IT&apos;S FOR</Text>
          <View style={styles.whoCard}>
            <View style={styles.whoRow}>
              <View style={styles.athletePlaque}>
                <Feather name="user" size={16} color="#F2E7CE" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.whoName}>{athleteName}</Text>
                {athleteMeta ? <Text style={styles.whoMeta}>{athleteMeta}</Text> : null}
              </View>
            </View>

            <View style={styles.whoDivider} />

            {brand ? (
              <View style={styles.whoRow}>
                <PitchAvatar
                  pitch={{
                    brandName: brand.name, brandLogo: brand.logoUrl, brandDomain: brand.domain,
                    status: "ready", stale: false,
                  }}
                  size={36}
                  ringColor={Colors.light.card}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.whoName}>{brand.name}</Text>
                  <Text style={styles.whoMeta}>{brand.category ?? "Brand"}</Text>
                </View>
                <Pressable onPress={() => nav.setParams({ brandId: undefined, brandName: undefined })} hitSlop={8}>
                  <Feather name="x" size={16} color={Colors.light.textMuted} />
                </Pressable>
              </View>
            ) : (
              <View style={styles.whoRow}>
                <View style={styles.brandEmpty}>
                  <Feather name="briefcase" size={16} color={Colors.light.textMuted} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.whoNameMuted}>No brand attached</Text>
                  <Text style={styles.whoMeta}>Personal content — nothing brand-tailored.</Text>
                </View>
              </View>
            )}
          </View>
        </View>

        {/* ── Goal ── */}
        <View style={styles.section}>
          <Text style={styles.eyebrow}>GOAL</Text>
          <View style={styles.pillRow}>
            {OBJECTIVES.filter((o) => !o.needsBrand || brand).map((o) => (
              <Pill key={o.value} label={o.label} active={o.value === objective} onPress={() => { setObjective(o.value); invalidate(); }} />
            ))}
          </View>
        </View>

        {/* ── The brief ── */}
        <View style={styles.section}>
          <Text style={styles.eyebrow}>THE BRIEF</Text>
          <TextInput
            style={styles.brief}
            value={direction}
            onChangeText={(t) => { setDirection(t); invalidate(); }}
            placeholder="What should this show? e.g. mid-stride on the field, hard evening light."
            placeholderTextColor={Colors.light.textMuted}
            multiline
            textAlignVertical="top"
          />
          <Text style={styles.hint}>Leave it blank and we&apos;ll work from your goal.</Text>
        </View>

        {/* ── The pre-check ── */}
        <View style={styles.section}>
          <Text style={styles.eyebrow}>BEFORE ANYTHING RUNS</Text>

          <Pressable
            style={[styles.checkBtn, canCheck && !preview.isPending ? null : styles.checkBtnOff]}
            onPress={runCheck}
            disabled={!canCheck || preview.isPending}
          >
            {preview.isPending
              ? <ActivityIndicator size="small" color={Colors.light.buttonText} />
              : <Feather name="search" size={15} color={Colors.light.buttonText} />}
            <Text style={styles.checkBtnTxt}>
              {preview.isPending ? "Checking…" : "Check what this would cost"}
            </Text>
          </Pressable>

          {needsSource && !sourceAssetId ? (
            <Text style={styles.hint}>Pick the photo you want to change first.</Text>
          ) : needsSource && regions.length === 0 ? (
            <Text style={styles.hint}>Drag a box around the part you want changed.</Text>
          ) : needsSource && labelledRegions.length !== regions.length ? (
            <Text style={styles.hint}>Say what should change in each box you drew.</Text>
          ) : untaggedRefs ? (
            <Text style={styles.hint}>Say what each photo is for.</Text>
          ) : null}

          {preview.isError ? (
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>Couldn&apos;t check this</Text>
              <Text style={styles.panelBody}>{preview.error?.message}</Text>
            </View>
          ) : null}

          {result ? <PreviewPanel result={result} /> : null}
        </View>

        {/* ── Generate — the only thing on this screen that spends ── */}
        <View style={styles.section}>
          <Pressable
            style={[styles.genBtn, canGenerate ? styles.genBtnOn : styles.genBtnOff]}
            onPress={runGenerate}
            disabled={!canGenerate}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canGenerate }}
          >
            {gen.isPending
              ? <ActivityIndicator size="small" color={Colors.light.buttonText} />
              : <Feather name="zap" size={15} color={canGenerate ? Colors.light.buttonText : Colors.light.textMuted} />}
            <Text style={[styles.genBtnTxt, canGenerate && styles.genBtnTxtOn]}>
              {gen.isPending ? "Making it…" : "Generate"}
            </Text>
          </Pressable>

          <Text style={styles.hint}>
            {gen.isPending
              ? "Running now — this charges the estimate above."
              : result?.verdict.canGenerate
                ? "This will charge the estimate above."
                : "Check the cost first — nothing has run and nothing has been charged."}
          </Text>
        </View>

        <GenerationResult
          assets={assets}
          busy={clearance.isPending}
          note={runNote}
          error={runError}
          onDecide={decide}
          onTryAgain={lastRequest ? tryAgain : undefined}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

/** The pre-check verdict. Money is always an ESTIMATE here — the preview has not run anything. */
function PreviewPanel({ result }: { result: NonNullable<ReturnType<typeof usePreviewGeneration>["data"]> }) {
  // A block we caused (no mask UI yet) is not a gap in HER material, and must not be dressed as one.
  const ours = !!result.unavailable;
  const ok = result.verdict.canGenerate;

  return (
    <View style={[styles.panel, ok ? styles.panelOk : ours ? styles.panelSoon : styles.panelBlocked]}>
      <View style={styles.panelHead}>
        <Feather
          name={ok ? "check-circle" : ours ? "clock" : "alert-circle"}
          size={15}
          color={ok ? Bold.ink : Colors.light.textMuted}
        />
        <Text style={styles.panelTitle}>{result.verdict.headline}</Text>
      </View>

      {result.verdict.reason ? <Text style={styles.panelBody}>{result.verdict.reason}</Text> : null}

      {result.cost ? (
        <View style={styles.costRow}>
          <Text style={styles.costLabel}>Estimated cost</Text>
          <Text style={styles.costValue}>
            {result.unpriced ? "Unknown" : `$${result.cost.amountUsd.toFixed(2)}`}
          </Text>
        </View>
      ) : null}
      {result.cost?.detail && !result.unpriced ? <Text style={styles.costDetail}>{result.cost.detail}</Text> : null}

      {result.plan ? (
        <Text style={styles.planLine}>
          {result.plan.model} · {result.plan.inputs.references} reference
          {result.plan.inputs.references === 1 ? "" : "s"}
          {result.plan.inputs.durationSeconds ? ` · ${result.plan.inputs.durationSeconds}s` : ""}
        </Text>
      ) : null}

      {/* Only HER gaps are listed as things to fix. Ours is already stated in the headline. */}
      {!ours && result.blockers.length ? (
        <View style={styles.gaps}>
          {result.blockers.map((b, i) => (
            <Text key={i} style={styles.gapBlocking}>• {b.note}</Text>
          ))}
        </View>
      ) : null}

      {result.warnings.length ? (
        <View style={styles.gaps}>
          {result.warnings.slice(0, 3).map((w, i) => (
            <Text key={i} style={styles.gapWarn}>• {w.note}</Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The frame an edit must stay continuous with, picked from her own library.
 *
 * Reads the existing GET /me/media (photos only) rather than adding a picker mode to
 * MediaLibraryScreen — that screen is outside this lane and does not need to change for this.
 * Only the asset_id travels; the server re-reads the path, width and height from the row under her
 * own athlete_id, so nothing here is trusted with the frame's identity.
 */
function SourcePicker({
  selected, onSelect,
}: { selected?: string; onSelect: (id: string, url: string | null) => void }) {
  const { data, isLoading } = useMyMedia("photos");
  const items = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <View style={styles.section}>
      <Text style={styles.eyebrow}>THE PHOTO TO CHANGE</Text>
      {isLoading ? (
        <View style={styles.srcEmpty}><ActivityIndicator size="small" color={Colors.light.primary} /></View>
      ) : items.length === 0 ? (
        <View style={styles.srcEmpty}>
          <Text style={styles.panelBody}>No photos in your library yet.</Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.srcRow}>
          {items.slice(0, 24).map((m) => (
            <Pressable
              key={m.asset_id}
              style={[styles.srcTile, m.asset_id === selected ? styles.srcTileOn : null]}
              // `url` is the full signed original, not `thumb_url` — the mask editor needs the frame
              // at a size worth drawing on, and the tile above it keeps using the thumbnail.
              onPress={() => onSelect(m.asset_id, m.url)}
            >
              {m.thumb_url ? <Image source={{ uri: m.thumb_url }} style={styles.srcImg} resizeMode="cover" /> : null}
              {m.asset_id === selected ? (
                <View style={styles.srcCheck}>
                  <Feather name="check" size={13} color={Colors.light.buttonText} />
                </View>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.pill, active ? styles.pillOn : null]} onPress={onPress}>
      <Text style={[styles.pillTxt, active ? styles.pillTxtOn : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  topbar: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, paddingBottom: Spacing.md,
  },
  backBtn: {
    width: 38, height: 38, borderRadius: BorderRadius.xs, alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
  },
  topbarTitle: { fontFamily: Fonts.display, fontSize: 22, fontWeight: "800", letterSpacing: -0.4, color: Colors.light.text },

  section: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.xl },
  eyebrow: {
    fontFamily: Fonts.bodyBold, fontSize: 10.5, letterSpacing: 1.4, fontWeight: "700",
    color: Colors.light.textMuted, marginBottom: 10,
  },
  hint: { fontFamily: Fonts.body, fontSize: 11.5, color: Colors.light.textMuted, marginTop: 8 },

  objCard: {
    flexDirection: "row", alignItems: "center", gap: 12, padding: Spacing.lg,
    backgroundColor: Colors.light.card, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: Colors.light.border,
  },
  objIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.xs, alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.light.primaryLight,
  },
  objLabel: { fontFamily: Fonts.bodyBold, fontSize: 15.5, fontWeight: "700", color: Colors.light.text },
  objBlurb: { fontFamily: Fonts.body, fontSize: 12.5, color: Colors.light.textMuted, marginTop: 2 },

  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: {
    minHeight: 36, paddingHorizontal: Spacing.lg, justifyContent: "center",
    borderRadius: BorderRadius.full, backgroundColor: Colors.light.card,
    borderWidth: 1, borderColor: Colors.light.border,
  },
  pillOn: { backgroundColor: Colors.light.primaryLight, borderColor: Colors.light.primary },
  pillTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 13, fontWeight: "600", color: Colors.light.textMuted },
  pillTxtOn: { color: Colors.light.primary, fontFamily: Fonts.bodyBold, fontWeight: "700" },

  whoCard: {
    backgroundColor: Colors.light.card, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: Colors.light.border, paddingVertical: Spacing.sm,
  },
  whoRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  whoDivider: { height: 1, backgroundColor: Colors.light.borderLight, marginHorizontal: Spacing.lg },
  athletePlaque: {
    width: 36, height: 36, borderRadius: 10, backgroundColor: Brand.heroBg,
    alignItems: "center", justifyContent: "center",
  },
  brandEmpty: {
    width: 36, height: 36, borderRadius: 10, backgroundColor: Colors.light.backgroundSecondary,
    alignItems: "center", justifyContent: "center",
  },
  whoName: { fontFamily: Fonts.bodySemiBold, fontSize: 14.5, fontWeight: "600", color: Colors.light.text },
  whoNameMuted: { fontFamily: Fonts.bodySemiBold, fontSize: 14.5, fontWeight: "600", color: Colors.light.textMuted },
  whoMeta: { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted, marginTop: 1 },

  brief: {
    minHeight: 96, padding: Spacing.lg,
    backgroundColor: Colors.light.card, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: Colors.light.border,
    fontFamily: Fonts.body, fontSize: 14.5, color: Colors.light.text, lineHeight: 21,
  },

  // source picker
  srcRow: { gap: 10, paddingVertical: 2 },
  srcEmpty: {
    height: 96, alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.light.card, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderStyle: "dashed", borderColor: Colors.light.border,
  },
  srcTile: {
    width: 84, height: 108, borderRadius: BorderRadius.xs, overflow: "hidden",
    backgroundColor: Colors.light.backgroundSecondary, borderWidth: 2, borderColor: "transparent",
  },
  srcTileOn: { borderColor: Colors.light.primary },
  srcImg: { width: "100%", height: "100%" },
  srcCheck: {
    position: "absolute", top: 5, right: 5, width: 20, height: 20, borderRadius: 10,
    alignItems: "center", justifyContent: "center", backgroundColor: Colors.light.primary,
  },

  // pre-check
  checkBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    minWidth: 120, height: 46, paddingHorizontal: Spacing.xl,
    borderRadius: BorderRadius.full, backgroundColor: Colors.light.primary,
  },
  checkBtnOff: { opacity: 0.45 },
  checkBtnTxt: { fontFamily: Fonts.bodyBold, fontSize: 14, fontWeight: "700", color: Colors.light.buttonText },

  panel: {
    marginTop: Spacing.md, padding: Spacing.lg, gap: 6,
    backgroundColor: Colors.light.card, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: Colors.light.border,
  },
  panelOk:      { borderColor: Bold.ink },
  panelSoon:    { borderColor: Colors.light.border },
  panelBlocked: { borderColor: Colors.light.warning },
  panelHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  panelTitle: { fontFamily: Fonts.bodyBold, fontSize: 14.5, fontWeight: "700", color: Colors.light.text },
  panelBody: { fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18, color: Colors.light.textMuted },

  costRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginTop: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: Colors.light.borderLight,
  },
  costLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 13, fontWeight: "600", color: Colors.light.textMuted },
  costValue: { fontFamily: Fonts.display, fontSize: 19, fontWeight: "800", color: Colors.light.text },
  costDetail: { fontFamily: Fonts.body, fontSize: 11, color: Colors.light.textMuted },
  planLine: { fontFamily: Fonts.body, fontSize: 11, color: Colors.light.textMuted },

  gaps: { gap: 4, marginTop: 4 },
  gapBlocking: { fontFamily: Fonts.body, fontSize: 12, lineHeight: 17, color: Colors.light.warning },
  gapWarn: { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16, color: Colors.light.textMuted },

  genBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    minWidth: 120, height: 46, paddingHorizontal: Spacing.xl,
    borderRadius: BorderRadius.full, backgroundColor: Colors.light.backgroundSecondary,
  },
  // Live: the button that spends reads as the primary action once the check clears, and stays
  // visibly inert until it does.
  genBtnOn:  { backgroundColor: Colors.light.primary },
  genBtnOff: { opacity: 0.7 },
  genBtnTxt: { fontFamily: Fonts.bodyBold, fontSize: 14, fontWeight: "700", color: Colors.light.textMuted },
  genBtnTxtOn: { color: Colors.light.buttonText },
});
