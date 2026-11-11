/**
 * AgentScreen — "or let the agent build this for you".
 *
 * ─── WHAT IT DOES, AND WHAT IT NEVER DOES ───────────────────────────────────────────────────────
 *
 * She says what she wants, picks anything she wants in it, and the server plans it from her own
 * photographs (POST /studio/agent/plan — one model call, no preview, no spend). This screen then
 * PRICES the plan with the Board's own code — `seedRowsFrom` → `boardRequests` → `previewNow` →
 * `boardQuote` — and shows the figure as an ESTIMATE. "Put it on the board" hands the rows to the
 * Board, which quotes them fresh and is the only place anything is spent.
 *
 * Two numbers, on purpose (decided 21 Sep 2026): the estimate lets her decide whether a plan is
 * worth taking to the Board at all, before she leaves this screen; the Board's own fresh quote is
 * the only number that spends. The label says so, so the two diverging (a check expiring, a cap
 * moving) surprises nobody.
 *
 * ─── WHAT SHE PICKS ─────────────────────────────────────────────────────────────────────────────
 *
 *   photos     cast FIRST, into the items they fit (server/studio/agent/cast.ts)
 *   products   up to five photos, each shown as a product — never searched for, taken by the plan's
 *              product items in the order she picked them, and the only way the planner is offered a
 *              product item at all. One the plan leaves out is named, never silently dropped.
 *   videos     her clips — uploaded or made here — placed as they are at the END of the video, in
 *              the order she picked them. Never quoted, never planned around.
 *
 * All three are the shared Studio picker (components/studio/StudioMediaPicker.tsx): her uploads and
 * what she made here (MOUNT_ORIGINS — synced posts stay off until the EXIF re-measure), searchable
 * and paged past the first 24 in "View more". The picker draws her picks and reports taps; the caps
 * and the order are still this screen's.
 *
 * DESIGN.md: pills at least 120px; cards at radius `lg`; no blur; Feather icons; Outfit throughout.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { StudioStackParamList } from "../../navigation/MainTabNavigator";
import { HapticPressable } from "../../components/HapticPressable";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import { StudioMediaPicker } from "../../components/studio/StudioMediaPicker";
import { EditPopover } from "../../components/studio/EditPopover";
import { EditSheet } from "../../components/studio/EditSheet";
import {
  STUDIO_BRIEF_CARRIER,
  STUDIO_COMPOSER,
  STUDIO_CLIP_READ,
  STUDIO_IMAGE_EDIT,
} from "../../lib/flags";
import { useClipRead } from "../../hooks/use-studio-media";
import {
  pickVideo,
  readAffordance,
  readDone,
  readNotDone,
  setCutOn,
  withRead,
  type ClipRead,
} from "./clipReadLogic";
import { useRecommendEdits } from "../../hooks/use-studio-edits";
import {
  briefLinesFrom,
  lastPickedAfterToggle,
  swapIn,
  toggleIn,
  type LastPicked,
} from "./editPopoverLogic";
import type { EditRec, StudioEditOp } from "./editTypes";

import { WhyChip } from "../../components/studio/WhyChip";
import { MOUNT_ORIGINS, type PickerRow } from "./mediaPickerLogic";
import {
  conceptsWithAgent,
  openStoredPlan,
  planWithAgent,
  replanStoredPlan,
  previewNow,
  type AgentConcept,
  type AgentPlanAnswer,
  type StudioObjective,
} from "../../hooks/use-studio";
import { useStitchOptions } from "../../hooks/use-studio-stitch";
import { newId } from "../../hooks/use-studio-sessions";
import {
  agentRequest,
  buildSeed,
  clipCapRefusal,
  EDIT_CHIP_LABEL,
  editChip,
  holdRefusal,
  KIND_LABEL,
  MAX_PICKED,
  MAX_PRODUCTS,
  OBJECTIVE_CHOICES,
  MOTION_CARD_LABEL,
  PAN_HOLD_SEC,
  picksLeftOut,
  productsLeftOut,
  provenanceWords,
  reasonWords,
  seedRowsFrom,
  briefBody,
  inheritedBody,
  inheritFromStoredPlan,
  regeneratePlan,
  planSeedExtras,
  type InheritedPlan,
} from "./agentLogic";
import { boardRequests, rowQuoteFrom } from "./storyboardRun";
import {
  asIsVideos,
  boardQuote,
  cutVideos,
  type PickedVideo,
  type RowQuote,
} from "./storyboardLogic";

const money = (n: number) => `$${n.toFixed(2)}`;

/** A plan on screen, with what it was asked for — so a changed ask can be told from this one. */
interface Planned {
  nonce: string;
  objective: StudioObjective;
  askedFor: string;
  answer: AgentPlanAnswer;
}

export function AgentScreen() {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  const route = useRoute<RouteProp<StudioStackParamList, "StudioAgent">>();
  const fromPlanId = route.params?.fromPlanId ?? null;
  /**
   * FROM A CONFIRMED BRIEF (PR 7, Lane E; Adi's ruling 23 Sep 2026 supersedes 6d's terminate-in-Board
   * for the brief path): the brand flow lands HERE, pre-filled from the brief she confirmed — the
   * composed ask, the tone triple as the feel, the goal as the purpose — every field hers to edit;
   * the structured brief, her concept, the brief file and the deal ride the plan call regardless
   * (`briefBody`). Nothing plans until her tap.
   */
  const fromBrief = route.params?.fromBrief ?? null;

  // ── What she asks for ───────────────────────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState(fromBrief?.prompt ?? "");
  const [objective, setObjective] = useState<StudioObjective>(
    fromBrief?.objective ?? OBJECTIVE_CHOICES[0].value,
  );
  const [aesthetic, setAesthetic] = useState(fromBrief?.aesthetic ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const [products, setProducts] = useState<string[]>(
    fromBrief?.productIds ?? [],
  );
  const [videos, setVideos] = useState<PickedVideo[]>([]);

  // ── What she can pick from: the shared picker, below — this screen keeps the caps ─────────────
  const videoIds = useMemo(() => videos.map((v) => v.assetId), [videos]);
  // The stitch's own clip limit, read from the server — never a number of ours.
  const options = useStitchOptions(true);
  const maxClips =
    options.data && options.data !== "unavailable"
      ? options.data.limits.maxClips
      : null;
  // The hold a held photo (`image` item) seeds with — the server's, never a number of ours.
  const defaultHold =
    options.data && options.data !== "unavailable"
      ? options.data.limits.defaultStillSec
      : null;

  // ── The plan, and its estimate ──────────────────────────────────────────────────────────────
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planned, setPlanned] = useState<Planned | null>(null);
  const [estimate, setEstimate] = useState<{
    quotes: RowQuote[];
    error: string | null;
    pricing: boolean;
  }>({ quotes: [], error: null, pricing: false });
  /** Bumped on every plan, so an answer that arrives after a newer ask is dropped, not shown. */
  const round = useRef(0);
  /**
   * CONCEPT BEFORE COVERAGE (PR 6, 6c): "Plan it" first asks for two or three ideas — none of her
   * library, one model call — and shows them with the first picked; nothing plans until she taps
   * "Plan this one". Held against the ask they were for, so a changed ask asks again.
   */
  const [ideas, setIdeas] = useState<{
    askedFor: string;
    concepts: AgentConcept[];
    picked: AgentConcept["id"];
  } | null>(null);
  const [ideating, setIdeating] = useState(false);
  /** Clip cards whose AI-edit chip is open (by item index). Nothing is fetched to open one. */
  const [editOpen, setEditOpen] = useState<Set<number>>(new Set());

  // Everything the SERVER plans from. A video she left on CUT is planned from (its beats); one on
  // AS IS is placed, not planned, so it is not in here.
  const cutIds = useMemo(
    () => cutVideos(videos).map((v) => v.assetId),
    [videos],
  );
  const askedFor = JSON.stringify([
    prompt.trim(),
    objective,
    aesthetic.trim(),
    picked,
    products,
    cutIds,
  ]);
  const stale = planned !== null && planned.askedFor !== askedFor;

  /**
   * FROM A PLANNED BOARD (PR 6, 6d): the door carried the board's stored plan. It is opened — GET, no
   * planner — and inherited (agentLogic `inheritFromStoredPlan`): the brief and the deal ride on every
   * request, the product photos and the brand objective are set, the re-plan is the stored plan's
   * child, and the ask starts from the brief's fallback line (her original words are not stored).
   */
  const [inherited, setInherited] = useState<InheritedPlan | null>(null);
  const [inheritError, setInheritError] = useState<string | null>(null);
  useEffect(() => {
    if (!fromPlanId) return;
    let live = true;
    openStoredPlan(fromPlanId).then(
      (answer) => {
        if (!live) return;
        const inh = inheritFromStoredPlan(answer);
        if (!inh) return;
        setInherited(inh);
        if (inh.objective) setObjective(inh.objective);
        if (inh.productIds.length) setProducts(inh.productIds);
        setPrompt((p) => p || inh.prompt);
        // Her feel line comes back with her words (PR 13) — unless she has already typed one.
        if (inh.aesthetic) setAesthetic((a) => a || inh.aesthetic);
      },
      (e) => {
        if (live)
          setInheritError(
            e instanceof Error ? e.message : "Couldn't open that plan.",
          );
      },
    );
    return () => {
      live = false;
    };
  }, [fromPlanId]);
  /** The brief and the deal an inherited plan adds to every request (agentLogic `inheritedBody`). */
  const carried = {
    ...inheritedBody(inherited, products.length),
    ...briefBody(fromBrief, products.length),
  };
  /** The concept she picked on the brief path — the idea, unless she asks for other ideas here. */
  const carriedConcept = fromBrief?.concept ?? null;
  const freshIdeas =
    ideas !== null && ideas.askedFor === askedFor ? ideas : null;

  const onIdeas = async () => {
    const req = agentRequest({
      prompt,
      objective,
      aesthetic,
      picked,
      products,
      videos,
    });
    if ("gap" in req) {
      setPlanError(req.gap);
      return;
    }
    const mine = ++round.current;
    setIdeating(true);
    setPlanError(null);
    try {
      const concepts = await conceptsWithAgent({ ...req.body, ...carried });
      if (mine !== round.current) return;
      setIdeas({ askedFor, concepts, picked: concepts[0].id });
    } catch (e) {
      if (mine === round.current)
        setPlanError(
          e instanceof Error
            ? e.message
            : "Couldn't find an idea in that. Nothing was spent.",
        );
    } finally {
      if (mine === round.current) setIdeating(false);
    }
  };

  const onPlan = async () => {
    const concept =
      freshIdeas?.concepts.find((c) => c.id === freshIdeas.picked) ??
      carriedConcept;
    const req = agentRequest({
      prompt,
      objective,
      aesthetic,
      picked,
      products,
      videos,
    });
    if ("gap" in req) {
      setPlanError(req.gap);
      return;
    }
    // A REGENERATE (PR 6, 6a3): the same ask planned again is a child of the plan on screen —
    // stored as version + 1 under it. A changed ask starts a new lineage.
    const parentPlanId =
      (planned && !stale ? (planned.answer.planId ?? null) : null) ??
      inherited?.parentPlanId ??
      null;
    const mine = ++round.current;
    setPlanning(true);
    setPlanError(null);
    setPlanned(null);
    setEstimate({ quotes: [], error: null, pricing: false });
    setEditOpen(new Set());

    let plan: Planned;
    try {
      const body = {
        ...req.body,
        ...carried,
        ...(concept ? { concept } : {}),
      };
      // A regenerate is the stored plan's child, through the replan route (PR 13, R-3); a pre-0066
      // parent falls back to the posted re-plan (agentLogic `regeneratePlan`). A first plan is a POST.
      const answer = parentPlanId
        ? await regeneratePlan(
            { replan: replanStoredPlan, plan: planWithAgent },
            parentPlanId,
            body,
          )
        : await planWithAgent(body);
      if (mine !== round.current) return;
      const nonce = newId();
      plan = { nonce, objective, askedFor, answer };
      setPlanned(plan);
    } catch (e) {
      if (mine === round.current) {
        setPlanError(
          e instanceof Error
            ? e.message
            : "Couldn't plan that. Nothing was spent.",
        );
        setPlanning(false);
      }
      return;
    }
    setPlanning(false);

    // ── The estimate: the BOARD's requests, one $0 preview per piece, the Board's own sum ────────
    setEstimate({ quotes: [], error: null, pricing: true });
    try {
      const quotes: RowQuote[] = [];
      // A held photo asks for nothing, so the hold it is seeded with cannot change these requests:
      // null here is exactly what the Board will ask for, whatever the options say.
      for (const r of boardRequests(
        seedRowsFrom(plan.answer.items, plan.nonce, null, STUDIO_COMPOSER),
        plan.objective,
        // The estimate is the Board's own requests, so it carries the plan's id as the Board will (PR 14).
        STUDIO_BRIEF_CARRIER ? (plan.answer.planId ?? null) : null,
        // …and asks for the slots the Board will (PR 15.1, R-1): composition and action with the composer.
        STUDIO_COMPOSER,
      )) {
        const p = await previewNow(r.request);
        if (mine !== round.current) return;
        quotes.push(rowQuoteFrom(r.key, p));
      }
      setEstimate({ quotes, error: null, pricing: false });
    } catch (e) {
      if (mine === round.current)
        setEstimate({
          quotes: [],
          error:
            e instanceof Error ? e.message : "Couldn't estimate this plan.",
          pricing: false,
        });
    }
  };

  // THE ROWS THE BOARD IS SEEDED WITH — the same rows the estimate was priced from, plus any held
  // photo at the server's default hold once the options have arrived. Derived, not stored, so a plan
  // made before the options landed still seeds its held photos.
  const rows = useMemo(
    () =>
      planned
        ? seedRowsFrom(
            planned.answer.items,
            planned.nonce,
            defaultHold,
            STUDIO_COMPOSER,
          )
        : [],
    [planned, defaultHold],
  );

  // No ceiling here on purpose (`null`): the Board asks admission for the real one. Only the sum is
  // read, and only when every piece came back priced.
  const quote = planned ? boardQuote(rows, estimate.quotes, [], null) : null;
  const showEstimate =
    quote !== null && quote.priced && !estimate.pricing && rows.length > 0;

  const capRefusal = planned
    ? clipCapRefusal(rows.length, asIsVideos(videos).length, maxClips)
    : null;
  const waitRefusal = planned
    ? holdRefusal(planned.answer.items, defaultHold)
    : null;
  const canSeed =
    planned !== null &&
    !stale &&
    !planning &&
    rows.length > 0 &&
    capRefusal === null &&
    waitRefusal === null;

  const onSeed = () => {
    if (!planned || !canSeed) return;
    nav.navigate("StudioHome", {
      tab: "board",
      seed: buildSeed(
        planned.nonce,
        planned.objective,
        rows,
        videos,
        planned.answer.planId ?? null,
        // The plan's look and music, and the deal linkage — the Board takes all of it (6d); and, with
        // the composer on, the brief's reading rhythm (PR 15, D-2) — the confirmed brief on a fresh
        // plan, the stored plan's brief on an inherited one.
        planSeedExtras(
          planned.answer,
          !!inherited?.dealDeliverableId,
          STUDIO_COMPOSER
            ? (fromBrief?.campaign ?? inherited?.campaign ?? null)
            : null,
        ),
      ),
    });
  };

  /** Add to the end of an ordered pick list, or take out — never past its cap. */
  // ─── The edit popover (PR 9, Lane 3a): follows the toggle, never gates it ─────────────────────
  //
  // `lastPicked` is the photo she just SELECTED (editPopoverLogic.ts): set from the toggle's outcome,
  // cleared by the next interaction. The picker never sees it; selection never reads it. Behind the
  // client flag, so with it off the toggles below are exactly the old ones.
  const [lastPicked, setLastPicked] = useState<LastPicked | null>(null);
  const [editSheet, setEditSheet] = useState<{
    source: LastPicked;
    initial: { op: StudioEditOp; params: Record<string, unknown> } | null;
  } | null>(null);
  const briefLines = useMemo(
    () => briefLinesFrom(fromBrief?.campaign ?? null),
    [fromBrief],
  );
  const recommend = useRecommendEdits(
    STUDIO_IMAGE_EDIT ? (lastPicked?.assetId ?? null) : null,
    briefLines,
    fromBrief?.brandName ?? null,
  );
  const togglePick = (assetId: string) => {
    const next = toggleIn(picked, assetId, MAX_PICKED);
    setPicked(next);
    setLastPicked(lastPickedAfterToggle("picked", picked, next, assetId));
  };
  const toggleProduct = (assetId: string) => {
    const next = toggleIn(products, assetId, MAX_PRODUCTS);
    setProducts(next);
    setLastPicked(lastPickedAfterToggle("products", products, next, assetId));
  };
  const openEdit = (
    source: LastPicked,
    initial: { op: StudioEditOp; params: Record<string, unknown> } | null,
  ) => setEditSheet({ source, initial });
  const onRec = (source: LastPicked, rec: EditRec) =>
    openEdit(source, { op: rec.op, params: rec.params });
  /** The accepted edit takes the source's place in her picks — the server's id, exactly. */
  const onAccepted = (source: LastPicked, acceptedAssetId: string) => {
    if (source.list === "picked")
      setPicked((l) => swapIn(l, source.assetId, acceptedAssetId));
    else setProducts((l) => swapIn(l, source.assetId, acceptedAssetId));
    setEditSheet(null);
    setLastPicked(null);
  };
  const popoverFor = (list: LastPicked["list"]) =>
    STUDIO_IMAGE_EDIT && lastPicked && lastPicked.list === list ? (
      <EditPopover
        picked={lastPicked}
        answer={
          briefLines.length
            ? recommend.data
            : { recs: [], skipped: "no_brief", refusal: null }
        }
        loading={briefLines.length > 0 && recommend.isFetching}
        onRec={(rec) => onRec(lastPicked, rec)}
        onManual={() => openEdit(lastPicked, null)}
        onDismiss={() => setLastPicked(null)}
      />
    ) : null;
  const leftOut = planned
    ? productsLeftOut(products, planned.answer.items)
    : null;
  const picksOut = planned
    ? picksLeftOut(
        [...picked, ...cutIds],
        planned.answer.items,
        planned.answer.picksWithoutHer ?? [],
      )
    : null;
  const toggleVideo = (clip: PickedVideo) => {
    setLastPicked(null);
    return setVideos((l) =>
      l.some((v) => v.assetId === clip.assetId)
        ? l.filter((v) => v.assetId !== clip.assetId)
        : [...l, clip],
    );
  };
  /** Cut it into the plan, or add it as it is — a video WITH beats only (clipReadLogic.setCutOn). */
  const setCut = (assetId: string, cut: boolean) =>
    setVideos((l) => setCutOn(l, assetId, cut));
  // ── Read this clip (PR 9.5): the tap, then each state the row passes through, onto the tray ────
  const clipRead = useClipRead();
  const onRead = (assetId: string, r: ClipRead) =>
    setVideos((l) =>
      r.state === "done"
        ? readDone(l, assetId, r.beats)
        : r.state === "reading"
          ? withRead(l, assetId, r)
          : readNotDone(l, assetId, r),
    );
  const startRead = (v: PickedVideo) => {
    const quotedUsd = v.read && v.read.state !== "done" ? v.read.quotedUsd : 0;
    clipRead.mutate({
      assetId: v.assetId,
      quotedUsd,
      onRead: (r) => onRead(v.assetId, r),
    });
  };

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
        <Text style={styles.topTitle}>Let the agent plan it</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {fromBrief ? (
          <View style={styles.plan} accessibilityLabel="From your brief">
            <Text style={styles.label}>
              FROM YOUR BRIEF · {fromBrief.brandName.toUpperCase()}
            </Text>
            <Text style={styles.hint}>
              Everything below is filled from the brief you confirmed — edit any
              of it. The brief itself rides with the plan either way.
            </Text>
            {carriedConcept ? (
              <View style={styles.item}>
                <View style={styles.itemMain}>
                  <Text style={styles.itemKind}>
                    {`THE IDEA · ${carriedConcept.feeling.toUpperCase()}`}
                  </Text>
                  <Text style={styles.itemBeat}>{carriedConcept.angle}</Text>
                  <Text style={styles.itemDirection}>
                    {carriedConcept.line}
                  </Text>
                </View>
              </View>
            ) : null}
          </View>
        ) : null}

        <Text style={styles.label}>WHAT SHOULD IT BE?</Text>
        <TextInput
          style={styles.prompt}
          value={prompt}
          onChangeText={(v) => {
            setLastPicked(null);
            setPrompt(v);
          }}
          placeholder="Say it the way you'd tell a friend — a 20-second recap of the tournament"
          placeholderTextColor={Colors.light.textMuted}
          multiline
          accessibilityLabel="What you want made"
        />

        <Text style={styles.label}>WHAT IT&apos;S FOR</Text>
        <View style={styles.pills}>
          {OBJECTIVE_CHOICES.map((o) => {
            const on = objective === o.value;
            return (
              <Pressable
                key={o.value}
                style={[styles.pill, on && styles.pillOn]}
                onPress={() => setObjective(o.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={o.label}
              >
                <Text style={[styles.pillTxt, on && styles.pillTxtOn]}>
                  {o.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.label}>HOW IT SHOULD FEEL · OPTIONAL</Text>
        <TextInput
          style={styles.line}
          value={aesthetic}
          onChangeText={(v) => {
            setLastPicked(null);
            setAesthetic(v);
          }}
          placeholder="Warm, slow, golden light"
          placeholderTextColor={Colors.light.textMuted}
          accessibilityLabel="How it should feel"
        />

        <Text style={styles.label}>
          PHOTOS TO USE · OPTIONAL · UP TO {MAX_PICKED}
        </Text>
        <StudioMediaPicker
          kind="photos"
          origins={MOUNT_ORIGINS["agent-pick"]}
          context="agent-pick"
          selectedIds={picked}
          numbered
          upload="photo"
          label="Use this photo"
          onPick={(r) => togglePick(r.assetId)}
          renderTile={(r, t) => (
            <Tile
              row={r}
              mark={t.mark}
              onPress={t.onPress}
              label="Use this photo"
            />
          )}
        />

        {popoverFor("picked")}

        <Text style={styles.label}>
          YOUR PRODUCTS · OPTIONAL · UP TO {MAX_PRODUCTS}
        </Text>
        <StudioMediaPicker
          kind="photos"
          origins={MOUNT_ORIGINS["agent-product"]}
          context="agent-product"
          selectedIds={products}
          numbered
          upload="photo"
          label="This is one of my products"
          onPick={(r) => toggleProduct(r.assetId)}
          renderTile={(r, t) => (
            <Tile
              row={r}
              mark={t.mark}
              onPress={t.onPress}
              label="This is one of my products"
            />
          )}
        />

        {popoverFor("products")}

        <Text style={styles.label}>YOUR VIDEOS · OPTIONAL</Text>
        <Text style={styles.hint}>
          A video that has been read into beats is cut into the plan — the plan
          picks the moments. Or add it at the end, as it is. A video not read
          yet is added at the end.
        </Text>
        <StudioMediaPicker
          kind="clips"
          origins={MOUNT_ORIGINS["agent-video"]}
          context="agent-video"
          selectedIds={videoIds}
          numbered
          upload="video"
          label="Add this video"
          empty="No videos yet."
          onPick={(r) => {
            // With beats, CUT by default — the first thing a real user does is pick a video and
            // expect the plan to use it, not to append 51 s of it (clipReadLogic.pickVideo).
            if (r.kind === "clip") toggleVideo(pickVideo(r));
          }}
          renderTile={(r, t) => (
            <Tile
              row={r}
              mark={t.mark}
              onPress={t.onPress}
              label="Add this video"
            />
          )}
        />
        {videos.map((v) => (
          <View key={v.assetId} style={styles.videoChoice}>
            {v.posterUrl ? (
              <Image source={{ uri: v.posterUrl }} style={styles.videoThumb} />
            ) : (
              <View style={[styles.videoThumb, styles.thumbBlank]}>
                <Feather name="film" size={14} color={Colors.light.textMuted} />
              </View>
            )}
            {v.beats > 0 ? (
              <View style={styles.chips}>
                {(
                  [
                    [
                      true,
                      `Cut it · ${v.beats} ${v.beats === 1 ? "beat" : "beats"}`,
                    ],
                    [false, "As is, at the end"],
                  ] as const
                ).map(([cut, txt]) => (
                  <Pressable
                    key={String(cut)}
                    style={[styles.chip, v.cut === cut && styles.chipOn]}
                    onPress={() => setCut(v.assetId, cut)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: v.cut === cut }}
                    accessibilityLabel={txt}
                  >
                    <Text
                      style={[
                        styles.chipTxt,
                        v.cut === cut && styles.chipTxtOn,
                      ]}
                    >
                      {txt}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <View style={styles.readCol}>
                <Text style={styles.hint}>
                  Added at the end, as-is · $0 — this clip hasn&apos;t been read
                  yet, so the plan can&apos;t cut into it.
                </Text>
                <ReadPill
                  read={v.read ?? null}
                  onPress={() => startRead(v)}
                  testID={`read-clip-${v.assetId}`}
                />
              </View>
            )}
          </View>
        ))}

        <Pressable
          style={[
            styles.cta,
            (planning || ideating || !prompt.trim()) && styles.ctaOff,
          ]}
          // A carried concept plans on this tap; otherwise the concept step comes first (6c).
          onPress={carriedConcept && !freshIdeas ? onPlan : onIdeas}
          disabled={planning || ideating || !prompt.trim()}
          accessibilityRole="button"
          accessibilityState={{
            disabled: planning || ideating || !prompt.trim(),
            busy: ideating || planning,
          }}
          accessibilityLabel={freshIdeas ? "New ideas" : "Plan it"}
        >
          {ideating ? (
            <ActivityIndicator size="small" color={Colors.light.textMuted} />
          ) : (
            <Feather
              name="compass"
              size={15}
              color={
                prompt.trim() ? Colors.light.buttonText : Colors.light.textMuted
              }
            />
          )}
          <Text
            style={[
              styles.ctaTxt,
              !planning && prompt.trim() ? styles.ctaTxtOn : null,
            ]}
          >
            {ideating
              ? "Thinking…"
              : planning && carriedConcept && !freshIdeas
                ? "Planning…"
                : freshIdeas
                  ? "New ideas"
                  : "Plan it"}
          </Text>
        </Pressable>
        {carriedConcept && !freshIdeas ? (
          <HapticPressable
            onPress={onIdeas}
            disabled={planning || ideating || !prompt.trim()}
            accessibilityRole="button"
            accessibilityLabel="Other ideas"
          >
            <Text style={styles.hint}>Or ask for other ideas first</Text>
          </HapticPressable>
        ) : null}
        {planError ? <Refusal text={planError} /> : null}
        {inheritError ? (
          // The board's stored plan could not be opened — said, never a silent blank ask (6d).
          <Refusal text={inheritError} />
        ) : null}

        {freshIdeas ? (
          // THE IDEAS (6c): picked by a tap, the first to start; nothing plans until "Plan this one".
          <View style={styles.plan}>
            <Text style={styles.label}>THE IDEA</Text>
            {freshIdeas.concepts.map((c) => {
              const on = c.id === freshIdeas.picked;
              return (
                <Pressable
                  key={c.id}
                  style={[styles.item, on && styles.ideaOn]}
                  onPress={() => setIdeas({ ...freshIdeas, picked: c.id })}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${c.angle}: ${c.line}`}
                >
                  <View style={styles.itemMain}>
                    <Text style={styles.itemKind}>
                      {`${c.id} · ${c.feeling.toUpperCase()}`}
                    </Text>
                    <Text style={styles.itemBeat}>{c.angle}</Text>
                    <Text style={styles.itemDirection}>{c.line}</Text>
                  </View>
                  <Feather
                    name={on ? "check-circle" : "circle"}
                    size={18}
                    color={on ? Colors.light.primary : Colors.light.textMuted}
                  />
                </Pressable>
              );
            })}
            <Pressable
              style={[styles.cta, planning && styles.ctaOff]}
              onPress={onPlan}
              disabled={planning}
              accessibilityRole="button"
              accessibilityState={{ disabled: planning, busy: planning }}
              accessibilityLabel={
                planned && !stale ? "Plan it again" : "Plan this one"
              }
            >
              {planning ? (
                <ActivityIndicator
                  size="small"
                  color={Colors.light.textMuted}
                />
              ) : (
                <Feather
                  name="compass"
                  size={15}
                  color={Colors.light.buttonText}
                />
              )}
              <Text style={[styles.ctaTxt, !planning ? styles.ctaTxtOn : null]}>
                {planning
                  ? "Planning…"
                  : planned && !stale
                    ? "Plan it again"
                    : "Plan this one"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {planned ? (
          <View style={styles.plan}>
            <Text style={styles.label}>THE PLAN</Text>
            {stale ? (
              <Refusal text="You've changed what you asked for — plan it again to see a plan for it." />
            ) : null}

            {planned.answer.items.map((item, i) =>
              item.kind === "clip" && item.assetId ? (
                // ONE OF HER CLIPS (C2 Half B): placed as it is, or cut to the beat the plan named,
                // at $0. Its own sound, kept when the planner said so.
                <View key={`i${i}`} style={styles.item}>
                  {item.thumbUrl ? (
                    <Image
                      source={{ uri: item.thumbUrl }}
                      style={styles.thumb}
                    />
                  ) : (
                    <View style={[styles.thumb, styles.thumbBlank]} />
                  )}
                  <View style={styles.itemMain}>
                    <Text style={styles.itemKind}>
                      {`${i + 1} · ${KIND_LABEL.clip.toUpperCase()}${
                        provenanceWords(item)
                          ? ` · ${provenanceWords(item)}`
                          : ""
                      } · $0 · ${
                        item.trim
                          ? `${item.trim.startSec}–${item.trim.endSec}S`
                          : "WHOLE CLIP"
                      }${item.sound ? " · ITS SOUND" : ""}`}
                    </Text>
                    {!item.trim && item.beats ? (
                      // A read landed after this plan was made (PR 9.5, B3): say so, and that her
                      // Plan-it tap is what cuts into it — this card never re-plans on its own.
                      <Text style={styles.hint}>
                        {`Read since · ${item.beats} ${item.beats === 1 ? "beat" : "beats"} — plan it again to cut into this clip.`}
                      </Text>
                    ) : null}
                    <Text style={styles.itemBeat}>{item.beat}</Text>
                    <Text style={styles.itemDirection}>{item.direction}</Text>
                    <WhyChip words={reasonWords(item.reason)} />
                    {item.swapped ? (
                      <View style={styles.flag}>
                        <Feather
                          name="shuffle"
                          size={12}
                          color={Colors.light.primary}
                        />
                        <Text style={styles.flagTxt}>{item.swapped}</Text>
                      </View>
                    ) : null}
                    {editChip(item) ? (
                      // THE AI-EDIT CHIP (C3, D1): the edit the tagger already wrote for this clip
                      // — a crop, a relight — opened in place. No model is called; the note was
                      // stored when the clip was read. It is a note to her, not a job: nothing is
                      // made from it here.
                      <Pressable
                        style={[
                          styles.editChip,
                          editOpen.has(i) && styles.editChipOn,
                        ]}
                        onPress={() =>
                          setEditOpen((s) => {
                            const next = new Set(s);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          })
                        }
                        accessibilityRole="button"
                        accessibilityState={{ expanded: editOpen.has(i) }}
                        accessibilityLabel={`${EDIT_CHIP_LABEL}: ${editChip(item)}`}
                      >
                        <Feather
                          name="scissors"
                          size={11}
                          color={
                            editOpen.has(i)
                              ? Colors.light.buttonText
                              : Colors.light.text
                          }
                        />
                        <Text
                          style={[
                            styles.editChipTxt,
                            editOpen.has(i) && styles.editChipTxtOn,
                          ]}
                        >
                          {editOpen.has(i)
                            ? `${EDIT_CHIP_LABEL} · ${editChip(item)}`
                            : EDIT_CHIP_LABEL}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              ) : item.kind === "image" && item.assetId ? (
                // A HELD PHOTO: shown as it is, for the server's default hold, at $0. Its hold is
                // changed on the Board; nothing about it is priced.
                <View key={`i${i}`} style={styles.item}>
                  {item.thumbUrl ? (
                    <Image
                      source={{ uri: item.thumbUrl }}
                      style={styles.thumb}
                    />
                  ) : (
                    <View style={[styles.thumb, styles.thumbBlank]} />
                  )}
                  <View style={styles.itemMain}>
                    <Text style={styles.itemKind}>
                      {
                        // WHERE THE PHOTO CAME FROM, on a held photo too (found on the round-2
                        // re-run, 22 Sep 2026: a made-here still pushed into a "what I filmed"
                        // recap with nothing on its card saying it was made here).
                        `${i + 1} · ${KIND_LABEL.image.toUpperCase()}${
                          provenanceWords(item)
                            ? ` · ${provenanceWords(item)}`
                            : ""
                        }${
                          item.motion
                            ? // A MOVING PHOTO (D2, PR 6): her photo pushed into or moved toward a
                              // point, at $0 — said in its own words, never "slight movement" (an i2v).
                              ` · ${MOTION_CARD_LABEL[item.motion]} · $0 · HELD ${PAN_HOLD_SEC}S`
                            : ` · $0 · HELD ${defaultHold ?? "—"}S`
                        }`
                      }
                    </Text>
                    <Text style={styles.itemBeat}>{item.beat}</Text>
                    <Text style={styles.itemDirection}>{item.direction}</Text>
                    <WhyChip words={reasonWords(item.reason)} />
                    {item.swapped ? (
                      <View style={styles.flag}>
                        <Feather
                          name="shuffle"
                          size={12}
                          color={Colors.light.primary}
                        />
                        <Text style={styles.flagTxt}>{item.swapped}</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              ) : item.assetId ? (
                <View key={`i${i}`} style={styles.item}>
                  {item.thumbUrl ? (
                    <Image
                      source={{ uri: item.thumbUrl }}
                      style={styles.thumb}
                    />
                  ) : (
                    <View style={[styles.thumb, styles.thumbBlank]} />
                  )}
                  <View style={styles.itemMain}>
                    <Text style={styles.itemKind}>
                      {`${i + 1} · ${KIND_LABEL[item.kind].toUpperCase()}${
                        provenanceWords(item)
                          ? ` · ${provenanceWords(item)}`
                          : ""
                      }${item.sound ? " · SOUND ON" : ""}`}
                    </Text>
                    <Text style={styles.itemBeat}>{item.beat}</Text>
                    <Text style={styles.itemDirection}>{item.direction}</Text>
                    <WhyChip words={reasonWords(item.reason)} />
                    {item.swapped ? (
                      // The direction was written about another photo: she checks it still fits.
                      <View style={styles.flag}>
                        <Feather
                          name="shuffle"
                          size={12}
                          color={Colors.light.primary}
                        />
                        <Text style={styles.flagTxt}>{item.swapped}</Text>
                      </View>
                    ) : null}
                    {item.rewritten ? (
                      // The words followed the photo out: the direction now describes the photo
                      // used (S1b, the leaked direction).
                      <View style={styles.flag}>
                        <Feather
                          name="edit-3"
                          size={12}
                          color={Colors.light.primary}
                        />
                        <Text style={styles.flagTxt}>{item.rewritten}</Text>
                      </View>
                    ) : null}
                    {item.demoted ? (
                      // Planned as an i2v, held instead: she asked for her own footage (PR 4 A1b).
                      <View style={styles.flag}>
                        <Feather
                          name="pause-circle"
                          size={12}
                          color={Colors.light.primary}
                        />
                        <Text style={styles.flagTxt}>{item.demoted}</Text>
                      </View>
                    ) : null}
                    {item.brandFlag ? (
                      // A fact, not a verdict: the shot stays in the plan. To swap it, remove the
                      // row on the Board and add another photo.
                      <View style={styles.flag}>
                        <Feather
                          name="tag"
                          size={12}
                          color={Colors.light.primary}
                        />
                        <Text style={styles.flagTxt}>{item.brandFlag}</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              ) : !item.uncast ? (
                // B-ROLL, MADE FROM WORDS. Not left out: it goes on the Board as a photo-less row,
                // marked with the Board's own sign for one (the `type` icon, StoryboardTab).
                <View key={`i${i}`} style={styles.item}>
                  <View style={[styles.thumb, styles.thumbBlank]}>
                    <Feather
                      name="type"
                      size={16}
                      color={Colors.light.textMuted}
                    />
                  </View>
                  <View style={styles.itemMain}>
                    <Text style={styles.itemKind}>
                      {`${i + 1} · ${KIND_LABEL[item.kind].toUpperCase()} · MADE FROM WORDS${item.sound ? " · SOUND ON" : ""}`}
                    </Text>
                    <Text style={styles.itemBeat}>{item.beat}</Text>
                    <Text style={styles.itemDirection}>{item.direction}</Text>
                    <WhyChip words={reasonWords(item.reason)} />
                  </View>
                </View>
              ) : (
                // ⚠️ DROPPED AND SHOWN. The Board will not get this item; she sees where it was.
                <View key={`i${i}`} style={[styles.item, styles.itemDropped]}>
                  <View style={[styles.thumb, styles.thumbBlank]}>
                    <Feather
                      name="image"
                      size={16}
                      color={Colors.light.textMuted}
                    />
                  </View>
                  <View style={styles.itemMain}>
                    <Text style={styles.itemKind}>{`${i + 1} · LEFT OUT`}</Text>
                    <Text style={styles.itemBeat}>{item.beat}</Text>
                    <Text style={styles.itemDirection}>{item.uncast}</Text>
                    {item.rewritten ? (
                      <Text style={styles.flagTxt}>{item.rewritten}</Text>
                    ) : null}
                  </View>
                </View>
              ),
            )}

            {leftOut ? <Refusal text={leftOut} /> : null}
            {picksOut ? <Refusal text={picksOut} /> : null}

            {asIsVideos(videos).map((v, i) => (
              <View key={v.assetId} style={styles.item}>
                {v.posterUrl ? (
                  <Image source={{ uri: v.posterUrl }} style={styles.thumb} />
                ) : (
                  <View style={[styles.thumb, styles.thumbBlank]}>
                    <Feather
                      name="film"
                      size={16}
                      color={Colors.light.textMuted}
                    />
                  </View>
                )}
                <View style={styles.itemMain}>
                  <Text
                    style={styles.itemKind}
                  >{`YOUR VIDEO · AT THE END · ${i + 1}`}</Text>
                  <Text style={styles.itemDirection}>
                    Placed as it is — nothing is made from it, and it costs
                    nothing.
                  </Text>
                </View>
              </View>
            ))}

            <View style={styles.quote}>
              <Text style={styles.label}>
                ESTIMATE — FINAL PRICE ON THE BOARD
              </Text>
              <Text style={styles.quoteBig}>
                {showEstimate ? money(quote!.ceilingUsd) : "—"}
              </Text>
              <Text style={styles.hint}>
                {estimate.pricing
                  ? "Pricing it the way the Board will…"
                  : estimate.error
                    ? estimate.error
                    : quote && !quote.priced && rows.length > 0
                      ? "One of these shots can't be priced yet — the Board will say which."
                      : planned.answer.items.some(
                            (it) => it.sound && it.assetId,
                          )
                        ? "Priced with the Board's own check, sound included — turn sound off on the Board if you don't want it. Nothing is spent until you make the board."
                        : "Priced with the Board's own check. Nothing is spent until you make the board."}
              </Text>
            </View>

            {capRefusal ? <Refusal text={capRefusal} /> : null}
            {waitRefusal ? <Refusal text={waitRefusal} /> : null}

            <Pressable
              style={[styles.cta, !canSeed && styles.ctaOff]}
              onPress={onSeed}
              disabled={!canSeed}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSeed }}
              accessibilityLabel="Put it on the board"
            >
              <Feather
                name="arrow-right"
                size={15}
                color={
                  canSeed ? Colors.light.buttonText : Colors.light.textMuted
                }
              />
              <Text style={[styles.ctaTxt, canSeed && styles.ctaTxtOn]}>
                Put it on the board
              </Text>
            </Pressable>
            <Text style={styles.hint}>
              The Board prices it fresh and asks before anything is made.
            </Text>
          </View>
        ) : null}
      </ScrollView>
      {editSheet ? (
        <EditSheet
          source={editSheet.source}
          initial={editSheet.initial}
          productIds={products}
          onClose={() => setEditSheet(null)}
          onAccepted={(id) => onAccepted(editSheet.source, id)}
        />
      ) : null}
    </SafeAreaView>
  );
}

/** One tile in a picker strip, with its mark — the strip itself is the shared picker's. */
/**
 * "Read this clip · $0.0X" and its four other states (PR 9.5). Renders nothing with STUDIO_CLIP_READ
 * off, or when the server served no `read` — the passive hint above it stays either way.
 */
function ReadPill({
  read,
  onPress,
  testID,
}: {
  read: ClipRead | null;
  onPress: () => void;
  testID?: string;
}) {
  const a = readAffordance({ kind: "clip", read }, STUDIO_CLIP_READ);
  if (!a) return null;
  return (
    <View style={styles.readRow}>
      <Pressable
        testID={testID}
        style={[styles.chip, a.tappable ? styles.chipOn : styles.chipOff]}
        onPress={a.tappable ? onPress : undefined}
        disabled={!a.tappable}
        accessibilityRole="button"
        accessibilityState={{
          disabled: !a.tappable,
          busy: a.state === "reading",
        }}
        accessibilityLabel={a.label}
      >
        <Text style={[styles.chipTxt, a.tappable && styles.chipTxtOn]}>
          {a.label}
        </Text>
      </Pressable>
      {a.sub ? <Text style={styles.readSub}>{a.sub}</Text> : null}
    </View>
  );
}

function Tile({
  row,
  mark,
  onPress,
  label,
}: {
  row: PickerRow;
  /** Its order among her picks ("1", "2"), or null when it is not picked. */
  mark: string | null;
  onPress: () => void;
  label: string;
}) {
  const uri = row.kind === "photo" ? row.thumbUrl : row.posterUrl;
  return (
    <Pressable
      onPress={onPress}
      style={[styles.tile, mark !== null && styles.tileOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: mark !== null }}
      accessibilityLabel={label}
    >
      {uri ? (
        <Image source={{ uri }} style={styles.tileImg} />
      ) : (
        <View style={[styles.tileImg, styles.thumbBlank]} />
      )}
      {mark ? (
        <View style={styles.mark}>
          <Text style={styles.markTxt}>{mark}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function Refusal({ text }: { text: string }) {
  return (
    <View style={styles.refusal}>
      <Feather name="alert-circle" size={13} color={Colors.light.primary} />
      <Text style={styles.refusalTxt}>{text}</Text>
    </View>
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
    flex: 1,
    fontFamily: Fonts.bodyBold,
    fontSize: 15.5,
    fontWeight: "700",
    color: Colors.light.text,
  },
  body: { padding: Spacing.lg, paddingBottom: 48, gap: Spacing.sm },
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
  prompt: {
    fontFamily: Fonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: Colors.light.text,
    minHeight: 76,
    padding: Spacing.md,
    borderRadius: BorderRadius.sm,
    backgroundColor: Colors.light.backgroundDefault,
    textAlignVertical: "top",
  },
  line: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: Colors.light.text,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: BorderRadius.sm,
    backgroundColor: Colors.light.backgroundDefault,
  },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs },
  pill: {
    minWidth: 120,
    alignItems: "center",
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  pillOn: {
    borderColor: Colors.light.primary,
    backgroundColor: Colors.light.primaryLight,
  },
  pillTxt: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 12.5,
    color: Colors.light.textSecondary,
  },
  pillTxtOn: { color: Colors.light.primary },

  tile: {
    borderRadius: BorderRadius.xs,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "transparent",
  },
  tileOn: { borderColor: Colors.light.primary },
  tileImg: { width: 56, height: 76 },
  mark: {
    position: "absolute",
    top: 4,
    right: 4,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 999,
    backgroundColor: Colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  markTxt: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    color: Colors.light.buttonText,
  },

  plan: { gap: Spacing.sm, marginTop: Spacing.sm },
  item: {
    flexDirection: "row",
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  itemDropped: {
    backgroundColor: "transparent",
    borderStyle: "dashed",
  },
  thumb: {
    width: 56,
    height: 76,
    borderRadius: BorderRadius.xs,
    backgroundColor: Colors.light.border,
  },
  thumbBlank: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.light.backgroundSecondary,
  },
  itemMain: { flex: 1, gap: 3 },
  videoChoice: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  videoThumb: {
    width: 36,
    height: 48,
    borderRadius: BorderRadius.xs,
    backgroundColor: Colors.light.border,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs, flex: 1 },
  chip: {
    minWidth: 120,
    paddingHorizontal: Spacing.md,
    paddingVertical: 7,
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
  chipOff: { opacity: 0.55 },
  readCol: { flex: 1, gap: Spacing.xs },
  readRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: Spacing.xs,
  },
  readSub: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textMuted,
    flexShrink: 1,
  },
  editChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 5,
    minWidth: 120,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    marginTop: 4,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  editChipOn: {
    backgroundColor: Colors.light.text,
    borderColor: Colors.light.text,
  },
  editChipTxt: {
    flexShrink: 1,
    fontFamily: Fonts.bodySemiBold,
    fontSize: 11.5,
    fontWeight: "600",
    letterSpacing: 0.4,
    color: Colors.light.text,
  },
  editChipTxtOn: { color: Colors.light.buttonText },
  itemKind: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: Colors.light.textMuted,
  },
  itemBeat: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13.5,
    fontWeight: "600",
    color: Colors.light.text,
  },
  itemDirection: {
    fontFamily: Fonts.body,
    fontSize: 12.5,
    lineHeight: 17,
    color: Colors.light.textSecondary,
  },

  quote: {
    gap: Spacing.xs,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  quoteBig: {
    fontFamily: Fonts.displayBold,
    fontSize: 20,
    fontWeight: "700",
    color: Colors.light.text,
  },

  refusal: {
    flexDirection: "row",
    gap: 6,
    alignItems: "flex-start",
    marginTop: Spacing.xs,
  },
  refusalTxt: {
    flex: 1,
    fontFamily: Fonts.bodyMedium,
    fontSize: 12.5,
    lineHeight: 17,
    color: Colors.light.primary,
  },
  flag: {
    flexDirection: "row",
    gap: 5,
    alignItems: "center",
    marginTop: 4,
  },
  flagTxt: {
    flex: 1,
    fontFamily: Fonts.bodyMedium,
    fontSize: 12,
    lineHeight: 16,
    color: Colors.light.primary,
  },

  cta: {
    flexDirection: "row",
    gap: 7,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 120,
    paddingVertical: 13,
    borderRadius: 999,
    backgroundColor: Colors.light.primary,
    marginTop: Spacing.sm,
  },
  ctaOff: { backgroundColor: Colors.light.border },
  /** The picked idea: its border in the primary colour, nothing blurred or filled. */
  ideaOn: { borderColor: Colors.light.primary, borderWidth: 2 },
  ctaTxt: {
    fontFamily: Fonts.bodyBold,
    fontSize: 14,
    fontWeight: "700",
    color: Colors.light.textMuted,
  },
  ctaTxtOn: { color: Colors.light.buttonText },
});
