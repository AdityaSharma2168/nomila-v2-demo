/**
 * MakeItScreen — the spend boundary, and the only screen in Studio that costs money.
 *
 * ─── IT HAS ONE JOB ────────────────────────────────────────────────────────────────────────────
 * Get an informed yes. So the test for every element is: if this were wrong, would she press the
 * button anyway? Anything that fails it belongs somewhere else, and several things did — the
 * caption moved to the screen after this one (you write a caption for a thing that exists, not for
 * a thing you are about to gamble on), and the per-frame itemisation moved behind the honesty row.
 *
 * ─── INVENTION AND COST ARE ONE ROW ────────────────────────────────────────────────────────────
 * They are the same question asked twice: a frame only costs something when a model touches its
 * pixels. Previously a coloured banner about invention floated mid-page and the money sat in the
 * footer, which made them read as unrelated facts. Now: "2 of 3 frames invented · $0.19", tappable.
 *
 * The itemisation moving behind a tap is a checkout contract, not a hidden cost: the total and the
 * invented count stay on the face of the screen, and only the per-frame breakdown is one tap away.
 *
 * ─── WHAT AUTHORIZES THE SPEND ─────────────────────────────────────────────────────────────────
 * Not this screen. `POST /studio/preview` writes a row holding the quote, and `POST /studio/generate`
 * is sent ONLY that row's id — no cost field, so there is nothing here to forge. This screen renders
 * the preview and presses the button; the ceiling is the server's own record of what she was shown.
 */
import React, { useState } from "react";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  View, Text, ScrollView, SafeAreaView, StatusBar, StyleSheet, Image, Modal, Pressable,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { HapticPressable } from "../../components/HapticPressable";
import { Bold, BorderRadius, Brand, Colors, Fonts, Spacing } from "../../constants/theme";
import { MaskEditor, toStudioRegions, type DraftRegion } from "../../components/studio/MaskEditor";
import { regionToPixels, useContainedStage } from "../../hooks/use-contained-stage";
import {
  lineTagFor,
  previewCard,
  type BuiltFrom,
  type GenerationPlanView,
  type PlanFrame,
} from "../../lib/studio-contract";
import { inventionLine, isRefused, makeItCta, money, timecodes } from "./planLogic";
import { useGenerationPlan } from "../../hooks/use-studio-pending";
import { STUDIO_IDENTITY_PACK, STUDIO_IMAGE_OPS } from "../../lib/flags";
import {
  StudioUnavailable,
  useGenerate,
  useRejectInterpretation,
  type InterpretationLine,
  type StudioRegion,
} from "../../hooks/use-studio";
import type { StudioStackParamList } from "../../navigation/MainTabNavigator";

/**
 * The route. Everything the plan needs travels in params rather than a store: the flow is linear,
 * the payload is small and serializable, and a screen that can be reached with its own inputs is a
 * screen that can be opened from anywhere later — the brand flow and the personal flow both land
 * here with different material and no special case.
 */
export function MakeItRoute() {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  const { params } = useRoute<RouteProp<StudioStackParamList, "StudioMakeIt">>();
  /**
   * HER CORRECTION to the derived box, when she has made one.
   *
   * ─── SESSION-ONLY. THIS IS THE BOUNDARY, AND IT IS DELIBERATE. ────────────────────────────────
   *
   * Component state, and nothing else. It dies when the screen unmounts, exactly like the tray in
   * Create anything and for the same reason. Now that Create anything's threads are kept (behind
   * EXPO_PUBLIC_STUDIO_SESSIONS, where this same screen opens as a sheet — ThreadMakeIt), the mask
   * is still not: the check her correction mints is a new preview, its brief carries the regions,
   * and the thread keeps THAT preview's id. Check again starts from her words and her photos, and the
   * server re-derives the area — she re-marks if she needs to (plan v2 §4).
   *
   * Do not reach for AsyncStorage, a query cache, or a route param to keep this across a navigation
   * "while we are here". A corrected mask that outlives its preview is a mask pointing at a brief
   * that no longer exists.
   */
  const [correctedRegions, setCorrectedRegions] = useState<StudioRegion[] | null>(null);
  // "Just these photos" (PR 17): session-only, like the mask; absent is top-up. Only with the flag on
  // does the chip exist, and only then does the policy ride — off, the input is exactly what it was.
  const [justThese, setJustThese] = useState(false);
  const { data: plan, isLoading: checking } = useGenerationPlan({
    ...params,
    regions: correctedRegions,
    ...(STUDIO_IDENTITY_PACK && justThese ? { packPolicy: "just-these" as const } : {}),
  });
  const gen = useGenerate();
  const reject = useRejectInterpretation();

  /**
   * She marked the area herself. Sending explicit regions is what tells the server to stop deriving
   * one — and it re-runs the check, which re-quotes and mints a NEW previewId, so the approval she
   * eventually taps is against the mask she actually chose. The old previewId is dropped by
   * useGenerationPlan's own re-arm guard rather than left live over a changed brief.
   */
  const onCorrectRegions = (next: StudioRegion[]) => setCorrectedRegions(next);

  /** What the run itself said. Separate from the plan's blockers, which are about the BRIEF. */
  const [runError, setRunError] = useState<string | null>(null);
  const [runNote, setRunNote] = useState<string | null>(null);

  /**
   * THE ONE CALL THAT SPENDS. Sent a previewId and nothing else — the ceiling is the server's own
   * record of the figure she was shown, so there is deliberately nothing here to forge.
   *
   * It navigates on the GENERATED asset, never on the hero: the hero is the photograph this was
   * built FROM, and carrying it forward would show her the input on a screen that says "it is
   * made". A run that comes back with no asset stays put and says so rather than navigating to an
   * empty result.
   */
  const onMake = async () => {
    if (!plan.previewId || gen.isPending) return;
    setRunError(null);
    setRunNote(null);
    try {
      const run = await gen.mutateAsync({ previewId: plan.previewId });
      const made = run.assets.find((a) => a.url) ?? null;

      if (!made?.url) {
        // "already_running" ⇒ an identical tap already bought this; same job, one charge. It may
        // genuinely still be running, in which case there is nothing to show yet — say which.
        setRunNote(
          run.status === "already_running"
            ? "You'd already started this one. It'll appear on your shelf when it lands."
            : "It ran, but nothing came back to show. Check your shelf in a moment.",
        );
        return;
      }

      nav.navigate("StudioMade", {
        title: params.title,
        format: params.format,
        heroUri: made.url,
        brandName: params.brandName ?? null,
        assetId: made.assetId,
      });
    } catch (e) {
      // StudioUnavailable is the server having the capability switched off (video today) rather
      // than refusing HER, and its message is already a sentence written for her.
      setRunError(
        e instanceof StudioUnavailable || e instanceof Error
          ? e.message
          : "Something went wrong making this.",
      );
    }
  };

  /**
   * "NOT WHAT I MEANT" (the interpreter, I.6). The server records it on this preview and blocks it, so
   * the reading she refused can never be spent; then she goes back to the composer, where her words still
   * are — the screen below holds them, and nothing here re-sends them. A failure stays on this screen and
   * says so rather than leaving her unsure whether the refusal landed.
   */
  const onReject = async () => {
    if (!plan.previewId || reject.isPending) return;
    setRunError(null);
    try {
      await reject.mutateAsync({ previewId: plan.previewId });
      nav.goBack();
    } catch (e) {
      setRunError(
        e instanceof Error ? e.message : "Couldn't record that right now.",
      );
    }
  };

  return (
    <MakeItScreen
      plan={plan}
      checking={checking}
      busy={gen.isPending}
      runError={runError}
      runNote={runNote}
      onBack={() => nav.goBack()}
      onMake={onMake}
      onCorrectRegions={onCorrectRegions}
      onReject={onReject}
      rejecting={reject.isPending}
      // The chip exists only in a build with the pack flag on (PR 17); off, no prop is passed.
      {...(STUDIO_IDENTITY_PACK ? { justThese, onJustThese: setJustThese } : {})}
    />
  );
}

/**
 * "HERE'S WHAT WE'LL DO" — the interpreter's reading of her words, before she approves (the interpreter,
 * I.6; plan v1 §1, "How the preview renders it").
 *
 * Every line is the FROZEN intent's own words (server/studio/compile/describe.ts): what she reads is what
 * will run, never what a model said it would do. Each is tagged by where it came from — her words, our
 * suggestion, or required by the brand — because an ad adds things she did not ask for, and a card that
 * did not say which would be claiming her words for ours.
 *
 * Generate stays the one button that spends, so approving the preview is approving this reading (A2).
 * "Not what I meant" is the other answer: the preview is refused and she goes back to her words.
 */
export function InterpretationCard({
  lines,
  onReject,
  rejecting,
}: {
  lines: InterpretationLine[];
  onReject: (() => void) | null;
  rejecting: boolean;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardHead}>{"Here's what we'll do:"}</Text>
      {lines.map((l, i) => {
        const tag = lineTagFor(l.source);
        return (
          <View key={`${i}-${l.text.slice(0, 24)}`} style={styles.cardLine}>
            <Feather
              name={l.kind === "constraint" ? "shield" : "check"}
              size={14}
              color={Colors.light.text}
              style={styles.cardIcon}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.cardLineTxt}>{l.text}</Text>
              {tag ? (
                <Text
                  style={[
                    styles.cardTag,
                    l.source === "brand" && styles.cardTagBrand,
                  ]}
                >
                  {tag}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
      {onReject ? (
        <HapticPressable
          style={[styles.maskBtn, styles.maskBtnGhost, styles.cardReject]}
          onPress={onReject}
          disabled={rejecting}
          accessibilityRole="button"
          accessibilityLabel="Not what I meant"
          accessibilityState={{ disabled: rejecting, busy: rejecting }}
        >
          <Text style={styles.maskBtnGhostTxt}>
            {rejecting ? "Going back…" : "Not what I meant"}
          </Text>
        </HapticPressable>
      ) : null}
    </View>
  );
}

/**
 * WHAT THE BUTTON SAYS, AND WHAT DECIDES IT.
 *
 * The word "free" is bound to the SERVER's own figure and to nothing else. That is the whole point
 * of reading `jobCostUsd` directly here: a job costing $0.004 rounds to $0.00 once it is split
 * across the frames, so a summed-frames check would print "Make it — free" over a real charge —
 * and the dangerous direction is always the one that understates. planLogic's makeButton is
 * reached ONLY once the server has said zero, where it and the frames agree by construction.
 */
/**
 * The derived box, over the photograph, before she approves.
 *
 * ─── WHY THIS IS ON THE SPEND SCREEN AND NOT BEHIND A TAP ──────────────────────────────────────
 *
 * She never drew this box — the server read her sentence and decided what "the ball" meant. That is
 * the one thing on this screen she cannot verify from the words alone, and it is the thing that
 * decides which pixels of her photograph change. Every other mask in this product is one she drew
 * and is looking at; a derived one should not be the exception, and "we found it, trust us" is not
 * an answer on a screen whose next button spends money.
 *
 * Correcting it opens the same MaskEditor CampaignWorkspace uses, seeded with the derived box —
 * which works only because autoMask emits the identical wire format a drawn box does (fractions of
 * the frame). Sending explicit regions is what tells the server to stop deriving.
 */
function EditRegionPreview({
  uri,
  regions,
  onCorrect,
}: {
  uri: string;
  regions: StudioRegion[];
  onCorrect: ((next: StudioRegion[]) => void) | null;
}) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<DraftRegion[]>(() =>
    regions.map((r, i) => ({ ...r, id: `derived-${i}` })),
  );
  // Called unconditionally — hooks cannot sit behind the `editing` branch below.
  const { onLayout, stageHeight, drawn } = useContainedStage(uri);

  if (editing) {
    return (
      <View style={styles.maskBlock}>
        <MaskEditor imageUrl={uri} regions={drafts} onChange={setDrafts} />
        <View style={styles.maskActions}>
          <HapticPressable
            style={[styles.maskBtn, styles.maskBtnGhost]}
            onPress={() => {
              setDrafts(regions.map((r, i) => ({ ...r, id: `derived-${i}` })));
              setEditing(false);
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={styles.maskBtnGhostTxt}>Cancel</Text>
          </HapticPressable>
          <HapticPressable
            style={styles.maskBtn}
            onPress={() => {
              onCorrect?.(toStudioRegions(drafts));
              setEditing(false);
            }}
            accessibilityRole="button"
            accessibilityLabel="Use this area"
          >
            <Text style={styles.maskBtnTxt}>Use this area</Text>
          </HapticPressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.maskBlock}>
      <Text style={styles.maskHead}>
        {regions.length === 1 ? "This is what will change" : `These ${regions.length} areas will change`}
      </Text>
      {/*
        ⚠️ THE BOXES ARE POSITIONED AGAINST THE PHOTO, NOT AGAINST THIS CONTAINER.

        They used to be `left: ${r.left * 100}%` of a SQUARE stage while the photo was drawn into it
        with `resizeMode="contain"`. A portrait photo pillarboxes inside a square, so those
        percentages were measuring against the bars as well as the picture: on a 1008x1476 frame
        every box came out 1.46x too wide and shifted left by an amount that grew with `left`. Two
        sock boxes drifted apart far enough to strand a strip of sock in the gap between them, while
        the boxes the SERVER held were tight. The picture lied; the edit was correct.

        `useContainedStage` gives the stage the photo's own shape and reports where the photo landed,
        and `regionToPixels` divides by that rect. Same maths MaskEditor draws and stores with — one
        implementation, because a second correct copy is just a later chance to drift.
      */}
      <View style={[styles.maskStage, { height: stageHeight }]} onLayout={onLayout}>
        <Image source={{ uri }} style={styles.maskImg} resizeMode="contain" />
        {drawn
          ? regions.map((r, i) => (
              <View
                key={i}
                pointerEvents="none"
                style={[styles.maskBox, regionToPixels(r, drawn)]}
              />
            ))
          : null}
      </View>
      {onCorrect ? (
        <HapticPressable
          style={[styles.maskBtn, styles.maskBtnGhost]}
          onPress={() => setEditing(true)}
          accessibilityRole="button"
          accessibilityLabel="Change the area"
        >
          <Text style={styles.maskBtnGhostTxt}>Not quite — let me mark it</Text>
        </HapticPressable>
      ) : null}
    </View>
  );
}


export function MakeItScreen({
  plan, checking = false, busy = false, runError = null, runNote = null, onBack, onMake, onCorrectRegions,
  onReject,
  rejecting = false,
  justThese, onJustThese,
}: {
  plan: GenerationPlanView;
  /**
   * "Just these photos" (PR 17, R-3): when the route passes BOTH, a chip renders under BUILT FROM —
   * her word that her identity pack may not top up the person slots. A caller that passes neither
   * renders exactly what it rendered before; the route gates on the flag, not this component.
   */
  justThese?: boolean;
  onJustThese?: (v: boolean) => void;
  /** "Not what I meant" on an interpreted preview. Optional: without it the card has no way out but Back. */
  onReject?: () => void;
  /** The refusal is on its way to the server. */
  rejecting?: boolean;
  /**
   * She corrected the derived mask. Optional so every existing caller and test still compiles —
   * without it the box is shown but not editable, which is a degraded surface rather than a crash.
   */
  onCorrectRegions?: (next: StudioRegion[]) => void;
  /** The pre-generation check is in flight. Nothing on this screen is true yet. */
  checking?: boolean;
  /** The generation itself is running. */
  busy?: boolean;
  runError?: string | null;
  runNote?: string | null;
  onBack: () => void;
  onMake: () => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  // PR 19 (W-6): a refused plan names no price — not on the verdict row, not in the footer.
  const refused = STUDIO_IMAGE_OPS && isRefused(plan);
  const line = inventionLine(plan.frames, { refused });
  // The one button — a refused plan's is an enabled way back, never a dead "Make it" (PR 19; planLogic makeItCta).
  const button = makeItCta(plan, { refused, busy });
  const isVideo = plan.format === "video";
  const tc = timecodes(plan.frames.length);
  const invented = line.invented > 0;
  // "Here's what we'll do": the interpreter's card, or the rules' when her keep froze beside their steps (A3b).
  const card = previewCard(plan);
  // The run's own failure reads first: it is the most recent thing that happened, and a brief gap
  // she has already scrolled past is not what she needs to see after tapping the button.
  const notice = runError ?? plan.blockers[0] ?? null;
  const paid = !refused && (plan.jobCostUsd ?? 0) > 0;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.topbar}>
        <HapticPressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="chevron-left" size={22} color={Colors.light.text} />
        </HapticPressable>
        <View style={{ flex: 1 }} />
        <View style={styles.fmtTag}>
          <Text style={styles.fmtTxt}>{FORMAT_LABEL[plan.format]}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 20 }} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          {plan.heroUri ? (
            <Image source={{ uri: plan.heroUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.heroBlank]}>
              <Feather name="image" size={26} color={Colors.light.tabIconDefault} />
            </View>
          )}
          <View style={styles.heroScrim} />
          <Text style={styles.heroTitle}>{plan.title}</Text>
        </View>

        <View style={styles.pad}>
          <Text style={styles.concept}>{plan.line}</Text>

          {/* WHAT WE MADE OF HER WORDS — the interpreter's card, above the cost (I.6); or the same card on a
              preview the rules read with her keep beside them (A3b), where there is no reading to refuse, so
              no "Not what I meant". */}
          {card ? (
            <InterpretationCard
              lines={card.lines}
              onReject={card.refusable ? (onReject ?? null) : null}
              rejecting={rejecting}
            />
          ) : null}

          {/* WHAT THIS WILL CHANGE — shown before she approves, not after she has paid.

              ⚠️ NO "LET ME MARK IT" ON AN INTERPRETED PREVIEW (v1 §1). A box she draws is explicit spatial
              intent and routes masked, with her own words — where none of the interpreted sentence's
              guarantees hold. Her way out there is "Not what I meant". */}
          {plan.derivedRegions?.length && plan.editBaseUri ? (
            <EditRegionPreview
              uri={plan.editBaseUri}
              regions={plan.derivedRegions}
              onCorrect={plan.interpreting ? null : (onCorrectRegions ?? null)}
            />
          ) : null}

          {/* The whole verdict, in one tappable row. */}
          <HapticPressable
            style={[styles.honesty, invented ? styles.honestyWarn : styles.honestyGood]}
            onPress={() => setSheetOpen(true)}
            disabled={refused}
            accessibilityRole="button"
            accessibilityLabel={`${line.headline}. ${line.detail}`}
          >
            <Feather name={invented ? "zap" : "check-circle"} size={16} color={Colors.light.text} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.honestyHead}>{line.headline}</Text>
              <Text style={styles.honestyDetail}>{line.detail}</Text>
            </View>
            <Feather name="chevron-right" size={16} color={Colors.light.textSecondary} />
          </HapticPressable>

          {notice ? (
            <View style={styles.blocker}>
              <Text style={styles.blockerTxt}>{notice}</Text>
            </View>
          ) : null}

          {runNote ? (
            <View style={styles.note}>
              <Text style={styles.noteTxt}>{runNote}</Text>
            </View>
          ) : null}

          {/* Everything she attached that could not go, and why. Never silent — a reference that
              vanishes without a sentence is how a generation quietly stops being anchored on her. */}
          {plan.warnings.map((w, i) => (
            <View key={`${i}-${w.slice(0, 24)}`} style={styles.warn}>
              <Feather name="alert-circle" size={13} color={Colors.light.textSecondary} />
              <Text style={styles.warnTxt}>{w}</Text>
            </View>
          ))}

          {/* WHAT THIS IS ANCHORED ON — the survivors, not the tray. An inspiration image is in the
              tray and is not in the job, and a strip showing it would claim it did work it never
              did. See builtFromOf() in use-studio-pending. */}
          {plan.builtFrom.length > 0 ? (
            <>
              <Text style={styles.label}>BUILT FROM</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
                {plan.builtFrom.map((b) => (
                  <BuiltFromCell key={b.assetId} item={b} />
                ))}
              </ScrollView>
            </>
          ) : null}
          {/* "Just these photos" — her word that the pack may not fill her likeness slots (PR 17). */}
          {onJustThese ? (
            <Pressable
              onPress={() => onJustThese(!justThese)}
              style={[styles.packPill, justThese && styles.packPillOn]}
              accessibilityRole="switch"
              accessibilityState={{ checked: !!justThese }}
              testID="pack-just-these"
            >
              <Feather name={justThese ? "check-circle" : "circle"} size={13} color={justThese ? Colors.light.primary : Colors.light.textMuted} />
              <Text style={[styles.packPillTxt, justThese && styles.packPillTxtOn]}>Just these photos — don&apos;t add from my pack</Text>
            </Pressable>
          ) : null}

          <Text style={styles.label}>
            {isVideo ? "THE CUTS" : plan.format === "carousel" ? "THE SLIDES" : "THE FRAME"}
          </Text>

          {checking ? (
            <Text style={styles.muted}>
              {plan.interpreting
                ? "Working out what you mean…"
                : "Checking what this needs…"}
            </Text>
          ) : plan.frames.length === 0 ? (
            <Text style={styles.muted}>No frames yet. Go back and add some.</Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
              {/* No per-cell price. The engine quotes ONE figure for the job, and printing a share
                  of it under each frame would present an invented number as a quote. The total is
                  in the footer and the sheet, where it is the server's own. */}
              {plan.frames.map((f, i) => (
                <View key={f.id} style={styles.cell}>
                  <View style={styles.cellImg}>
                    <View style={[StyleSheet.absoluteFill, styles.heroBlank]}>
                      <Feather name="zap" size={16} color={Colors.light.tabIconDefault} />
                    </View>
                    <View style={styles.cellNum}>
                      <Text style={styles.cellNumTxt}>{String(i + 1).padStart(2, "0")}</Text>
                    </View>
                  </View>
                  {isVideo ? (
                    <View style={styles.cellMeta}>
                      <Text style={styles.cellAt}>{tc[i]?.at}s</Text>
                    </View>
                  ) : null}
                  <Text style={styles.cellName} numberOfLines={1}>{f.name}</Text>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        {/* THE SERVER'S FIGURE, not a sum of the frames. See planLogic's makeItCta(). */}
        {paid ? (
          <Text style={styles.footTotal}>
            <Text style={styles.footTotalBig}>{money(plan.jobCostUsd as number)}</Text>
            {`  ·  one job, ${plan.frames.length} ${plan.frames.length === 1 ? "frame" : "frames"}`}
          </Text>
        ) : null}
        <HapticPressable
          haptic="press"
          style={[styles.cta, button.disabled && styles.ctaOff]}
          onPress={button.action === "back" ? onBack : onMake}
          disabled={button.disabled}
          accessibilityRole="button"
          accessibilityLabel={busy ? "Making it" : button.label}
          accessibilityState={{ disabled: button.disabled, busy }}
        >
          <Text style={styles.ctaTxt}>{busy ? "Making it…" : button.label}</Text>
        </HapticPressable>
        <Text style={styles.footNote}>{button.note}</Text>
      </View>

      <ItemisationSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        plan={plan}
      />
    </SafeAreaView>
  );
}

/**
 * What she is paying for.
 *
 * ─── ONE JOB, ONE NUMBER ───────────────────────────────────────────────────────────────────────
 * This used to itemise per frame. It cannot honestly, and the reason is not cosmetic: the engine
 * returns ONE EstimatedCost for the whole job, so any per-frame figure here would be that number
 * divided up and then presented as though the engine had quoted it. A receipt that invents its own
 * line items is worse than one line that is true.
 *
 * So the frames are still listed — she should see what is being made and that all of it is
 * rendered new — and the money is stated exactly once, as the server's own figure. When the engine
 * returns per-frame cost and tier, the line items become real and this comment goes.
 */
function ItemisationSheet({
  visible, onClose, plan,
}: {
  visible: boolean; onClose: () => void; plan: GenerationPlanView;
}) {
  const { frames, builtFrom, jobCostUsd } = plan;
  const anchors = builtFrom.filter((b) => b.role === "person").length;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <HapticPressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" haptic="none" />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <Text style={styles.sheetTitle}>What you are paying for</Text>
        <Text style={styles.sheetSub}>
          {`${frames.length} ${frames.length === 1 ? "frame" : "frames"}, rendered new. `}
          {anchors > 0
            ? `Anchored on ${anchors === 1 ? "your photo" : `your ${anchors} photos`} so it looks like you.`
            : "Nothing of yours under it, so all of it is invented."}
        </Text>

        <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
          {frames.map((f, i) => (
            <View key={f.id} style={styles.itemRow}>
              <View style={styles.itemThumb}>
                <View style={[StyleSheet.absoluteFill, styles.heroBlank]}>
                  <Feather name="zap" size={13} color={Colors.light.tabIconDefault} />
                </View>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.itemName}>{String(i + 1).padStart(2, "0")} · {f.name}</Text>
                <Text style={styles.itemWhy}>{f.note ?? f.why}</Text>
                <View style={styles.tierTag}>
                  <Text style={styles.tierTxt}>{TIER_LABEL[f.tier]}</Text>
                </View>
              </View>
            </View>
          ))}
        </ScrollView>

        {/* The one figure, straight off the preview row that will authorize the spend. */}
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Job</Text>
          <Text style={styles.totalValue}>
            {jobCostUsd === null ? "—" : money(jobCostUsd)}
          </Text>
        </View>
        <Text style={styles.totalNote}>
          The engine prices a job, not a frame, so this is the whole thing.
        </Text>
      </View>
    </Modal>
  );
}

/**
 * The engine role, in the strip's caps. An OBJECT is its own word: it is the thing an add places in
 * the frame, and labelling it PRODUCT told her it was the piece the job is about (PR C′).
 */
const BUILT_FROM_ROLE: Record<BuiltFrom["role"], string> = {
  person: "YOU",
  product: "PRODUCT",
  object: "OBJECT",
  // PR 18: its READING went, never its image. Still honestly part of what the result was built from.
  style_reference: "STYLE",
};

/** One piece of her material that actually went. The role is what the ENGINE was told it is. */
function BuiltFromCell({ item }: { item: BuiltFrom }) {
  return (
    <View style={styles.bfCell}>
      <View style={styles.bfImg}>
        {item.uri ? (
          <Image source={{ uri: item.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.heroBlank]}>
            <Feather name="image" size={15} color={Colors.light.tabIconDefault} />
          </View>
        )}
        <View style={styles.bfScrim} />
        <Text style={styles.bfRole}>{BUILT_FROM_ROLE[item.role]}</Text>
      </View>
      <Text style={styles.bfName} numberOfLines={1}>{item.name}</Text>
    </View>
  );
}

const FORMAT_LABEL: Record<GenerationPlanView["format"], string> = {
  photo: "Photo", carousel: "Carousel", video: "Video · 8s · 9:16", story: "Story",
};

const TIER_LABEL: Record<PlanFrame["tier"], string> = {
  untouched: "UNTOUCHED", fixed: "FIXED", invented: "INVENTED",
};

const CELL_W = 96;

/**
 * The derived-mask block. Cards use radius `lg`; the buttons are pills with the 120px minimum, per
 * DESIGN.md. No blur anywhere — this is a card, not a floating control over media.
 */
const maskStyles = {
  maskBlock: {
    marginTop: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.card,
    gap: Spacing.sm,
  },
  maskHead: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 13,
    color: Colors.light.text,
  },
  maskStage: {
    position: "relative" as const,
    width: "100%" as const,
    // No aspectRatio and no height here on purpose: `useContainedStage` derives the height from the
    // photo's own shape, so `contain` has nothing left to letterbox and the boxes land on the
    // picture. It was `aspectRatio: 1`, and a square stage is what pillarboxed every portrait.
    borderRadius: BorderRadius.md,
    overflow: "hidden" as const,
    backgroundColor: Brand.heroBg,
  },
  maskImg: { width: "100%" as const, height: "100%" as const },
  // A solid outline, never a blur or a scrim: she is being asked to judge a boundary, and anything
  // soft over it would be the UI making the box look more approximate than it is.
  maskBox: {
    position: "absolute" as const,
    borderWidth: 2,
    borderColor: Bold.paper,
    borderRadius: BorderRadius.xs,
  },
  maskActions: { flexDirection: "row" as const, gap: Spacing.sm },
  maskBtn: {
    minWidth: 120,
    flex: 1,
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: "center" as const,
    backgroundColor: Colors.light.text,
  },
  maskBtnTxt: { fontFamily: Fonts.bodyMedium, fontSize: 14, color: Colors.light.buttonText },
  maskBtnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: Colors.light.border },
  maskBtnGhostTxt: { fontFamily: Fonts.bodyMedium, fontSize: 14, color: Colors.light.text },
};

const styles = StyleSheet.create({
  ...maskStyles,
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  topbar: { flexDirection: "row", alignItems: "center", paddingHorizontal: Spacing.xl, paddingVertical: 10 },
  fmtTag: {
    backgroundColor: Colors.light.backgroundSecondary, borderRadius: 8,
    paddingHorizontal: 9, paddingVertical: 4,
  },
  fmtTxt: { fontFamily: Fonts.bodyBold, fontSize: 11, fontWeight: "700", color: Colors.light.textSecondary },

  hero: { height: 300, marginTop: 4, backgroundColor: Colors.light.backgroundSecondary },
  heroBlank: { alignItems: "center", justifyContent: "center" },
  heroScrim: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(13,11,8,0.28)" },
  heroTitle: {
    position: "absolute", left: 18, right: 18, bottom: 16,
    fontFamily: Fonts.display, fontSize: 21, fontWeight: "800",
    letterSpacing: -0.4, lineHeight: 27, color: Colors.light.buttonText,
  },

  pad: { paddingHorizontal: Spacing.xl, paddingTop: 15 },

  // "Here's what we'll do" (I.6). A card, so radius lg; no blur, no scrim — it is text she must read.
  card: {
    marginTop: Spacing.md,
    padding: Spacing.md,
    gap: 10,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  cardHead: {
    fontFamily: Fonts.bodyBold,
    fontSize: 14,
    fontWeight: "700",
    color: Colors.light.text,
  },
  cardLine: { flexDirection: "row", alignItems: "flex-start", gap: 9 },
  cardIcon: { marginTop: 2 },
  cardLineTxt: {
    fontFamily: Fonts.body,
    fontSize: 13.5,
    lineHeight: 19,
    color: Colors.light.text,
  },
  cardTag: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "500",
    color: Colors.light.textMuted,
    marginTop: 2,
  },
  cardTagBrand: { color: Colors.light.primary },
  cardReject: {
    flex: 0,
    alignSelf: "flex-start",
    paddingHorizontal: 18,
    marginTop: 4,
  },
  concept: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 22, color: Colors.light.textSecondary },

  honesty: {
    flexDirection: "row", alignItems: "center", gap: 10,
    borderRadius: 14, borderWidth: 1, padding: 12, marginTop: 13,
  },
  honestyGood: { backgroundColor: Colors.light.successLight, borderColor: Colors.light.success },
  honestyWarn: { backgroundColor: Colors.light.primaryLight, borderColor: Colors.light.primary },
  honestyHead: {
    fontFamily: Fonts.bodyBold, fontSize: 13.5, fontWeight: "800",
    lineHeight: 18, color: Colors.light.text,
  },
  honestyDetail: {
    fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16,
    color: Colors.light.textSecondary, marginTop: 2,
  },

  blocker: {
    backgroundColor: Colors.light.errorLight, borderRadius: 12, padding: 11, marginTop: 9,
  },
  blockerTxt: { fontFamily: Fonts.body, fontSize: 12, lineHeight: 17, color: Colors.light.text },

  note: {
    backgroundColor: Colors.light.backgroundSecondary, borderRadius: 12, padding: 11, marginTop: 9,
  },
  noteTxt: { fontFamily: Fonts.body, fontSize: 12, lineHeight: 17, color: Colors.light.text },

  warn: {
    flexDirection: "row", alignItems: "flex-start", gap: 8,
    borderRadius: 12, padding: 10, marginTop: 8,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  warnTxt: {
    flex: 1, fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16,
    color: Colors.light.textSecondary,
  },

  bfCell: { width: 68 },
  bfImg: {
    width: 68, height: 68, borderRadius: 12, overflow: "hidden",
    borderWidth: 1, borderColor: Colors.light.border,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  bfScrim: { position: "absolute", left: 0, right: 0, bottom: 0, height: 18, backgroundColor: "rgba(13,11,8,0.62)" },
  bfRole: {
    position: "absolute", left: 0, right: 0, bottom: 3,
    fontFamily: Fonts.bodyBold, fontSize: 7.5, fontWeight: "700",
    color: Colors.light.buttonText, textAlign: "center", letterSpacing: 0.4,
  },
  bfName: {
    fontFamily: Fonts.body, fontSize: 10.5, lineHeight: 14,
    color: Colors.light.textMuted, marginTop: 3,
  },

  label: {
    fontFamily: Fonts.bodyBold, fontSize: 10.5, fontWeight: "700", letterSpacing: 1.4,
    color: Colors.light.textMuted, marginTop: 22, marginBottom: 10,
  },
  muted: { fontFamily: Fonts.body, fontSize: 12, lineHeight: 17, color: Colors.light.textMuted },
  packPill: {
    flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start", minWidth: 120,
    marginTop: 12, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.card,
  },
  packPillOn: { borderColor: Colors.light.primary, backgroundColor: Colors.light.primaryLight },
  packPillTxt: { fontFamily: Fonts.bodyMedium, fontSize: 12, fontWeight: "500", color: Colors.light.textMuted },
  packPillTxtOn: { color: Colors.light.primary },

  strip: { gap: 9, paddingBottom: 2 },
  cell: { width: CELL_W },
  cellImg: {
    width: CELL_W, height: 122, borderRadius: 12, overflow: "hidden",
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.backgroundSecondary,
  },
  cellNoted: { borderColor: Colors.light.primary },
  cellNum: {
    position: "absolute", left: 5, top: 5, borderRadius: 5,
    paddingHorizontal: 6, paddingVertical: 2, backgroundColor: "rgba(13,11,8,0.72)",
  },
  cellNumTxt: { fontFamily: Fonts.bodyBold, fontSize: 9.5, fontWeight: "800", color: Colors.light.buttonText },
  cellDot: {
    position: "absolute", right: 5, top: 5, width: 9, height: 9, borderRadius: 99,
    backgroundColor: Colors.light.primary, borderWidth: 1.5, borderColor: Colors.light.buttonText,
  },
  cellMeta: { flexDirection: "row", alignItems: "baseline", gap: 5, marginTop: 5 },
  cellAt: { fontFamily: Fonts.bodyBold, fontSize: 9.5, fontWeight: "800", color: Colors.light.tabIconDefault },
  cellCost: { fontFamily: Fonts.bodyBold, fontSize: 9.5, fontWeight: "700", color: Colors.light.textMuted },
  cellCostPaid: { color: Colors.light.primary },
  cellName: {
    fontFamily: Fonts.body, fontSize: 10.5, lineHeight: 14,
    color: Colors.light.textMuted, marginTop: 1,
  },

  footer: {
    borderTopWidth: 1, borderTopColor: Colors.light.border, backgroundColor: Colors.light.card,
    paddingHorizontal: Spacing.xl, paddingTop: 11, paddingBottom: 16,
  },
  footTotal: { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted, marginBottom: 9 },
  footTotalBig: { fontFamily: Fonts.bodyBold, fontSize: 13, fontWeight: "700", color: Colors.light.text },
  cta: {
    backgroundColor: Colors.light.primary, borderRadius: 14,
    paddingVertical: 15, alignItems: "center",
  },
  ctaOff: { backgroundColor: Colors.light.backgroundTertiary },
  ctaTxt: { fontFamily: Fonts.bodyBold, fontSize: 15, fontWeight: "700", color: Colors.light.buttonText },
  footNote: {
    fontFamily: Fonts.body, fontSize: 10.5, lineHeight: 15,
    color: Colors.light.textMuted, textAlign: "center", marginTop: 7,
  },

  scrim: { flex: 1, backgroundColor: "rgba(13,11,8,0.42)" },
  sheet: {
    backgroundColor: Colors.light.backgroundRoot,
    borderTopLeftRadius: 26, borderTopRightRadius: 26,
    paddingHorizontal: Spacing.xl, paddingTop: 10, paddingBottom: 30,
  },
  grabber: {
    width: 38, height: 4, borderRadius: 99,
    backgroundColor: Colors.light.backgroundTertiary, alignSelf: "center", marginBottom: 14,
  },
  sheetTitle: {
    fontFamily: Fonts.display, fontSize: 17, fontWeight: "800",
    letterSpacing: -0.3, color: Colors.light.text,
  },
  sheetSub: {
    fontFamily: Fonts.body, fontSize: 12, lineHeight: 17,
    color: Colors.light.textMuted, marginTop: 3, marginBottom: 12,
  },
  itemRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 14, padding: 10, marginBottom: 7,
  },
  itemThumb: {
    width: 38, height: 48, borderRadius: 9, overflow: "hidden",
    backgroundColor: Colors.light.backgroundSecondary,
  },
  itemName: { fontFamily: Fonts.bodyBold, fontSize: 12.5, fontWeight: "700", color: Colors.light.text },
  itemWhy: {
    fontFamily: Fonts.body, fontSize: 11, lineHeight: 15,
    color: Colors.light.textMuted, marginTop: 2,
  },
  tierTag: {
    alignSelf: "flex-start", marginTop: 5, borderRadius: 5,
    paddingHorizontal: 5, paddingVertical: 2, backgroundColor: Colors.light.backgroundSecondary,
  },
  tierTxt: { fontFamily: Fonts.bodyBold, fontSize: 9, fontWeight: "700", color: Colors.light.textSecondary },
  itemRight: { alignItems: "flex-end" },
  itemCost: { fontFamily: Fonts.bodyBold, fontSize: 13, fontWeight: "800", color: Colors.light.text },
  itemLabel: { fontFamily: Fonts.body, fontSize: 9.5, color: Colors.light.textMuted, marginTop: 2 },

  totalRow: {
    flexDirection: "row", alignItems: "center", marginTop: 12, paddingTop: 11,
    borderTopWidth: 1, borderTopColor: Colors.light.border,
  },
  totalLabel: { flex: 1, fontFamily: Fonts.bodyBold, fontSize: 13, fontWeight: "700", color: Colors.light.text },
  totalValue: {
    fontFamily: Fonts.display, fontSize: 16, fontWeight: "800",
    letterSpacing: -0.3, color: Colors.light.text,
  },
  totalNote: {
    fontFamily: Fonts.body, fontSize: 10.5, lineHeight: 15,
    color: Colors.light.textMuted, marginTop: 6,
  },
});
