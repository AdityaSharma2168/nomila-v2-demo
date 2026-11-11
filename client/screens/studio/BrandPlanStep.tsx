/**
 * BrandPlanStep — the brand post's last step, when it plans onto the Board (PR 6, 6d). Replaces "Set it
 * up / Build the plan" behind STUDIO_AGENT + STUDIO_BRAND_PROFILES (client/lib/flags.ts); off, the old
 * the old set-up step is what she sees.
 *
 *   format     Video (the Board makes it) · Photo · Carousel · Story (made on the old screen — the Board
 *              is a video editor; TODO card: those formats on the Board)
 *   product    one photo of it, and / or a line of words (decision 2)
 *   words      her own, for the post
 *
 * "Plan it" asks for two or three ideas (the concept step: her words and the brief, none of her library
 * — one model call); she picks one, the first to start; "Plan this one" plans from the brief the screen
 * ASSEMBLED — brandLogic `brandCampaignBrief`, no model call — and lands her on the Board with the plan
 * as its rows, each with its why, its look and its music. Nothing on the Board runs or spends until she
 * taps it there.
 */
import React, { useState } from "react";
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
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { StudioStackParamList } from "../../navigation/MainTabNavigator";
import { HapticPressable } from "../../components/HapticPressable";
import { StudioMediaPicker } from "../../components/studio/StudioMediaPicker";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import { STUDIO_COMPOSER, STUDIO_IMAGE_EDIT } from "../../lib/flags";
import {
  conceptsWithAgent,
  planWithAgent,
  type AgentConcept,
} from "../../hooks/use-studio";
import { useMediaDetail } from "../../hooks/use-media-library";
import { useStitchOptions } from "../../hooks/use-studio-stitch";
import { newId } from "../../hooks/use-studio-sessions";
import { brandBoardSeed } from "./agentLogic";
import {
  boardMakes,
  brandCampaignBrief,
  brandFormatsFor,
  type BrandFormat,
  brandPlanBody,
  briefHandoff,
  campaignLinesFor,
  planStepAction,
  type StudioBrand,
} from "./brandLogic";
import { brandMismatch, type BriefProposal } from "./directionLogic";
import { MOUNT_ORIGINS } from "./mediaPickerLogic";
import { briefLinesFrom } from "./editPopoverLogic";

export function BrandPlanStep({
  brand,
  deliverable,
  briefFilePath,
  proposal = null,
  onBack,
}: {
  brand: StudioBrand;
  deliverable: { id: string; campaign: string | null } | null;
  briefFilePath: string | null;
  /** A brief she confirmed line by line (PR 7, Lane E): it IS the brief, and its concept the idea. */
  proposal?: BriefProposal | null;
  onBack: () => void;
}) {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  const options = useStitchOptions(true);
  // The hold a held photo seeds with — the server's, never a number of ours (as the Agent screen).
  const defaultHold =
    options.data && options.data !== "unavailable"
      ? options.data.limits.defaultStillSec
      : null;

  const [format, setFormat] = useState<BrandFormat>("video");
  const [productPhotoId, setProductPhotoId] = useState<string | null>(null);
  // The carousel's photo, picked HERE (Adi, 23 Sep 2026: "I should be able to see photos / select them
  // for myself before going to click Make a carousel") — the Carousel Create screen opens on it.
  const [carouselPhoto, setCarouselPhoto] = useState<{
    assetId: string;
    thumbUrl: string | null;
  } | null>(null);
  const [productLine, setProductLine] = useState("");
  const [instructions, setInstructions] = useState("");
  // A confirmed proposal's concept is the idea — it rides the plan call unchanged, and the concept
  // call is skipped unless she asks for new ideas (PR 7, decision 3).
  const proposalConcept: AgentConcept | null = proposal?.extras.concept
    ? { id: "A", ...proposal.extras.concept }
    : null;
  const [ideas, setIdeas] = useState<AgentConcept[] | null>(
    proposalConcept ? [proposalConcept] : null,
  );
  const [picked, setPicked] = useState<AgentConcept["id"] | null>(
    proposalConcept ? "A" : null,
  );
  // The product photo she picked, read for the brands it shows: another brand in frame is said,
  // never swallowed (the product-mismatch line).
  const { detail: productDetail } = useMediaDetail(productPhotoId ?? undefined);
  const mismatch = brandMismatch(
    productDetail?.vision?.brands_visible,
    brand.name,
  );
  const [busy, setBusy] = useState<"ideas" | "plan" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const input = {
    brand,
    deliverable,
    productPhotoId,
    productLine,
    instructions,
    briefFilePath,
    proposal,
  };
  // Anything she changes after the ideas makes them stale — asked again, never planned from old ones.
  const touch =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setIdeas(null);
      setPicked(null);
    };

  const onIdeas = async () => {
    setBusy("ideas");
    setError(null);
    try {
      const concepts = await conceptsWithAgent(brandPlanBody(input));
      setIdeas(concepts);
      setPicked(concepts[0]?.id ?? null);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Couldn't find an idea. Nothing was spent.",
      );
    } finally {
      setBusy(null);
    }
  };

  const onPlan = async () => {
    const concept = ideas?.find((c) => c.id === picked) ?? null;
    if (!concept) return;
    // THE BRIEF PATH (Adi's ruling, 23 Sep 2026): a confirmed brief goes to the agent's compose
    // screen pre-filled — the planner runs only on her tap there. The manual path plans here, as 6d built it.
    if (planStepAction(input) === "compose") {
      const handoff = briefHandoff(input, concept);
      if (handoff) {
        nav.navigate("StudioAgent", { fromBrief: handoff });
        return;
      }
    }
    setBusy("plan");
    setError(null);
    try {
      const answer = await planWithAgent({ ...brandPlanBody(input), concept });
      nav.navigate("StudioHome", {
        tab: "board",
        seed: brandBoardSeed(
          answer,
          newId(),
          defaultHold,
          deliverable !== null,
          // The composer (PR 15, D-2): the confirmed brief's readings, for their rhythm.
          STUDIO_COMPOSER ? (proposal?.brief ?? null) : null,
          // …and the flag itself, read here (PR 15.1, R-2) — never inferred from the brief.
          STUDIO_COMPOSER,
        ),
      });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Couldn't plan that. Nothing was spent.",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.topbar}>
        <HapticPressable
          onPress={onBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={22} color={Colors.light.text} />
        </HapticPressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.topTitle}>Plan it</Text>
          <Text style={styles.topSub}>
            {brand.name}
            {deliverable ? " · for your deal" : ""}
            {proposal
              ? " · brief confirmed"
              : briefFilePath
                ? " · brief attached"
                : ""}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.label}>WHAT IT IS</Text>
        <View style={styles.chips}>
          {brandFormatsFor(STUDIO_IMAGE_EDIT).map((f) => (
            <Pressable
              key={f.key}
              style={[styles.chip, format === f.key && styles.chipOn]}
              onPress={() => setFormat(f.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: format === f.key }}
              accessibilityLabel={f.label}
            >
              <Text
                style={[styles.chipTxt, format === f.key && styles.chipTxtOn]}
              >
                {f.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {!boardMakes(format) ? (
          <View style={styles.card}>
            <Text style={styles.label}>THE PHOTO</Text>
            <Text style={styles.hint}>
              One photo of yours — three ads from it for {brand.name}, on the
              next screen, downloaded frame by frame.
            </Text>
            <StudioMediaPicker
              kind="photos"
              origins={MOUNT_ORIGINS["agent-pick"]}
              context="agent-pick"
              selectedIds={carouselPhoto ? [carouselPhoto.assetId] : []}
              upload="photo"
              label="Use this photo"
              onPick={(r) => {
                if (r.kind !== "photo") return;
                setCarouselPhoto(
                  carouselPhoto?.assetId === r.assetId
                    ? null
                    : { assetId: r.assetId, thumbUrl: r.thumbUrl },
                );
              }}
              renderTile={(r, t) => {
                const uri = r.kind === "photo" ? r.thumbUrl : r.posterUrl;
                return (
                  <Pressable
                    onPress={t.onPress}
                    style={[styles.tile, t.mark !== null && styles.tileOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: t.mark !== null }}
                    accessibilityLabel="Use this photo"
                  >
                    {uri ? (
                      <Image source={{ uri }} style={styles.tileImg} />
                    ) : (
                      <View style={[styles.tileImg, styles.tileBlank]} />
                    )}
                  </Pressable>
                );
              }}
            />
            <Pressable
              style={[styles.cta, !carouselPhoto && styles.ctaOff]}
              disabled={!carouselPhoto}
              onPress={() => {
                if (!carouselPhoto) return;
                nav.navigate("StudioCarouselCreate", {
                  brand: brand.name,
                  campaign: campaignLinesFor(input),
                  briefLines: briefLinesFrom(brandCampaignBrief(input)),
                  refs: [carouselPhoto.assetId],
                  ...(carouselPhoto.thumbUrl
                    ? {
                        thumbs: {
                          [carouselPhoto.assetId]: carouselPhoto.thumbUrl,
                        },
                      }
                    : {}),
                });
              }}
              accessibilityRole="button"
              accessibilityState={{ disabled: !carouselPhoto }}
              accessibilityLabel="Make a carousel"
            >
              <Text style={[styles.ctaTxt, styles.ctaTxtOn]}>
                {carouselPhoto ? "Make a carousel" : "Pick the photo first"}
              </Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Text style={styles.label}>THE PRODUCT · OPTIONAL</Text>
            <StudioMediaPicker
              kind="photos"
              origins={MOUNT_ORIGINS["agent-product"]}
              context="agent-product"
              selectedIds={productPhotoId ? [productPhotoId] : []}
              upload="photo"
              label="This is the product"
              onPick={(r) =>
                touch(setProductPhotoId)(
                  productPhotoId === r.assetId ? null : r.assetId,
                )
              }
              renderTile={(r, t) => {
                const uri = r.kind === "photo" ? r.thumbUrl : r.posterUrl;
                return (
                  <Pressable
                    onPress={t.onPress}
                    style={[styles.tile, t.mark !== null && styles.tileOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: t.mark !== null }}
                    accessibilityLabel="This is the product"
                  >
                    {uri ? (
                      <Image source={{ uri }} style={styles.tileImg} />
                    ) : (
                      <View style={[styles.tileImg, styles.tileBlank]} />
                    )}
                  </Pressable>
                );
              }}
            />
            {mismatch.length ? (
              <Text
                style={styles.mismatch}
                accessibilityLabel="Product brand mismatch"
              >
                This photo shows {mismatch.join(", ")} — this post is for{" "}
                {brand.name}.
              </Text>
            ) : null}
            <TextInput
              style={styles.input}
              value={productLine}
              onChangeText={touch(setProductLine)}
              placeholder="Or say what it is — “the matte-black bottle”"
              placeholderTextColor={Colors.light.textMuted}
              maxLength={120}
              accessibilityLabel="The product, in your words"
            />

            <Text style={styles.label}>ANYTHING ELSE · OPTIONAL</Text>
            <TextInput
              style={[styles.input, styles.inputTall]}
              value={instructions}
              onChangeText={touch(setInstructions)}
              placeholder="What it should feel like, what to show"
              placeholderTextColor={Colors.light.textMuted}
              multiline
              maxLength={2000}
              accessibilityLabel="Anything else"
            />

            <Pressable
              style={[styles.cta, busy !== null && styles.ctaOff]}
              onPress={onIdeas}
              disabled={busy !== null}
              accessibilityRole="button"
              accessibilityState={{
                disabled: busy !== null,
                busy: busy === "ideas",
              }}
              accessibilityLabel={ideas ? "New ideas" : "Plan it"}
            >
              {busy === "ideas" ? (
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
              <Text style={[styles.ctaTxt, busy === null && styles.ctaTxtOn]}>
                {busy === "ideas"
                  ? "Thinking…"
                  : ideas
                    ? "New ideas"
                    : "Plan it"}
              </Text>
            </Pressable>

            {ideas ? (
              <View style={styles.ideas}>
                <Text style={styles.label}>THE IDEA</Text>
                {ideas.map((c) => {
                  const on = c.id === picked;
                  return (
                    <Pressable
                      key={c.id}
                      style={[styles.card, on && styles.cardOn]}
                      onPress={() => setPicked(c.id)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`${c.angle}: ${c.line}`}
                    >
                      <Text
                        style={styles.kind}
                      >{`${c.id} · ${c.feeling.toUpperCase()}`}</Text>
                      <Text style={styles.angle}>{c.angle}</Text>
                      <Text style={styles.hint}>{c.line}</Text>
                    </Pressable>
                  );
                })}
                <Pressable
                  style={[
                    styles.cta,
                    (busy !== null || defaultHold === null) && styles.ctaOff,
                  ]}
                  onPress={onPlan}
                  disabled={busy !== null || defaultHold === null}
                  accessibilityRole="button"
                  accessibilityState={{
                    disabled: busy !== null,
                    busy: busy === "plan",
                  }}
                  accessibilityLabel="Plan this one"
                >
                  {busy === "plan" ? (
                    <ActivityIndicator
                      size="small"
                      color={Colors.light.textMuted}
                    />
                  ) : (
                    <Feather
                      name="layout"
                      size={15}
                      color={Colors.light.buttonText}
                    />
                  )}
                  <Text
                    style={[styles.ctaTxt, busy === null && styles.ctaTxtOn]}
                  >
                    {busy === "plan" ? "Planning…" : "Plan this one"}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </>
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  mismatch: {
    fontFamily: Fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: Colors.light.warning,
    marginTop: 6,
  },
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: Spacing.xl,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.border,
  },
  topTitle: {
    fontFamily: Fonts.bodyBold,
    fontSize: 15.5,
    fontWeight: "700",
    color: Colors.light.text,
  },
  topSub: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: Colors.light.textMuted,
  },
  body: { padding: Spacing.xl, paddingBottom: 26, gap: Spacing.md },
  label: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: Colors.light.textMuted,
    marginTop: Spacing.sm,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  chipOn: {
    backgroundColor: Colors.light.text,
    borderColor: Colors.light.text,
  },
  chipTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12.5,
    fontWeight: "600",
    color: Colors.light.text,
  },
  chipTxtOn: { color: Colors.light.buttonText },
  card: {
    gap: 4,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  cardOn: { borderColor: Colors.light.primary, borderWidth: 2 },
  kind: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: Colors.light.textMuted,
  },
  angle: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13.5,
    fontWeight: "600",
    color: Colors.light.text,
  },
  hint: {
    fontFamily: Fonts.body,
    fontSize: 12.5,
    lineHeight: 17,
    color: Colors.light.textSecondary,
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontFamily: Fonts.body,
    fontSize: 14,
    color: Colors.light.text,
    backgroundColor: Colors.light.card,
  },
  inputTall: { minHeight: 84, textAlignVertical: "top" },
  tile: {
    width: 72,
    height: 72,
    borderRadius: BorderRadius.sm,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "transparent",
  },
  tileOn: { borderColor: Colors.light.primary },
  tileImg: { width: "100%", height: "100%" },
  tileBlank: { backgroundColor: Colors.light.border },
  ideas: { gap: Spacing.sm },
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
  ctaTxt: {
    fontFamily: Fonts.bodyBold,
    fontSize: 14,
    fontWeight: "700",
    color: Colors.light.textMuted,
  },
  ctaTxtOn: { color: Colors.light.buttonText },
  error: { fontFamily: Fonts.body, fontSize: 12.5, color: Colors.light.error },
});
