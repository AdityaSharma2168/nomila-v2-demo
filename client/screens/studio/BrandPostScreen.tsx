/**
 * BrandPostScreen — a post that is owed to somebody.
 *
 * ─── THREE STEPS, AND THE MIDDLE ONE HAS THREE DOORS ───────────────────────────────────────────
 * Which brand → what it is for → set it up. The middle step is the one that matters: picking an
 * open deliverable BINDS the post to it, so the work counts against the deal and inherits its
 * format and date. That binding is the whole reason brand posts are a separate door from personal
 * ones.
 *
 * Three ways through it, and they are peers rather than a path and two escapes:
 *   pick one of the open deliverables,
 *   upload a brief and let it be read,
 *   skip, and link it later.
 * The third is a line of text rather than a third card, because it is the quiet option and giving
 * it equal visual weight made the list read as "choose one of three unrelated things".
 *
 * ─── WHERE THE BRANDS COME FROM ────────────────────────────────────────────────────────────────
 * Her deals. `DealItem` already carries brandId, brandName and brandDomain, and brandId is exactly
 * what a preview request wants — so the brand list is real today with no new endpoint. The logo
 * comes from the repo's <BrandLogo>, which every brand surface uses. What is NOT
 * real is the deliverables behind each brand: there is no deal_deliverables table, so that list is
 * empty until Aditya builds it, and the screen says so rather than pretending.
 */
import React, { useEffect, useState } from "react";
import {
  View, Text, ScrollView, SafeAreaView, StatusBar, StyleSheet, ActivityIndicator, TextInput,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { StudioStackParamList } from "../../navigation/MainTabNavigator";
import { HapticPressable } from "../../components/HapticPressable";
import { BrandLogo } from "../../components/BrandLogo";
import { Colors, Fonts, Spacing } from "../../constants/theme";
import { useDeals } from "../../hooks/use-deals";
import { useDeliverables, type Deliverable } from "../../hooks/use-studio-pending";
import { SetupScreen } from "./SetupScreen";
import { BrandPlanStep } from "./BrandPlanStep";
import { brandsFromDeals, type StudioBrand } from "./brandLogic";
import { STUDIO_AGENT, STUDIO_BRAND_PROFILES, STUDIO_DIRECTION_MOMENTS } from "../../lib/flags";
import { pickBriefPdf } from "../../hooks/use-studio";
import {
  decomposeReference, proposeCampaign, researchMoment, summarizeBriefPicked, trendSignal,
} from "../../hooks/use-studio-direction";
import { ConfirmBriefStep } from "../../components/studio/ConfirmBriefStep";
import {
  isMoment, needsConfirm, pillarsFor, referenceSourceFor, toPriorContext, valueAt, type BriefProposal,
} from "./directionLogic";

/**
 * The brand post plans onto the Board (PR 6, 6d) only with both client flags on; off, "Set it up" is
 * what she sees, exactly as before.
 */
const PLANS_ONTO_BOARD = STUDIO_AGENT && STUDIO_BRAND_PROFILES;

export function BrandPostScreen() {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  const { deals, isLoading } = useDeals("active");
  const [brand, setBrand] = useState<StudioBrand | null>(null);
  const [context, setContext] = useState<BriefContext | null>(null);

  const brands = brandsFromDeals(deals ?? []);

  if (brand && context && PLANS_ONTO_BOARD) {
    return (
      <BrandPlanStep
        brand={brand}
        deliverable={context.deliverable}
        briefFilePath={context.briefFilePath}
        proposal={context.proposal}
        onBack={() => setContext(null)}
      />
    );
  }

  if (brand && context) {
    return (
      <SetupScreen
        initialFormat="photo"
        title="Set it up"
        subtitle={brand.name}
        brandName={brand.name}
        brandId={brand.brandId}
        concept={{
          title: context.campaign,
          line: "Shaped by their brief and what you have shot.",
        }}
        onBack={() => setContext(null)}
      />
    );
  }

  if (brand) {
    return <BriefStep brand={brand} onBack={() => setBrand(null)} onPick={setContext} />;
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.topbar}>
        <HapticPressable onPress={() => nav.goBack()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="chevron-left" size={22} color={Colors.light.text} />
        </HapticPressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.topTitle}>Which brand?</Text>
          <Text style={styles.topSub}>Brand posts are always for somebody</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <ActivityIndicator style={{ marginTop: 36 }} color={Colors.light.primary} />
        ) : brands.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No brands yet</Text>
            <Text style={styles.emptyBody}>
              Brands appear here as deals arrive. Make a personal post in the meantime.
            </Text>
          </View>
        ) : (
          brands.map((b) => (
            <HapticPressable
              key={b.brandId ?? b.name}
              style={styles.brandRow}
              onPress={() => setBrand(b)}
              accessibilityRole="button"
              accessibilityLabel={b.name}
            >
              <BrandLogo brandName={b.name} brandDomain={b.domain} size={36} borderRadius={12} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.brandName}>{b.name}</Text>
                <Text style={styles.brandSub}>{b.dealCount} {b.dealCount === 1 ? "deal" : "deals"}</Text>
              </View>
              <Feather name="chevron-right" size={16} color={Colors.light.tabIconDefault} />
            </HapticPressable>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * What the brief step hands on: the campaign line, the deliverable she bound it to, her brief's path,
 * and — when a direction tool read one and she confirmed it line by line — the proposal (PR 7).
 */
interface BriefContext {
  campaign: string;
  deliverable: { id: string; campaign: string | null } | null;
  briefFilePath: string | null;
  /** The brief she confirmed on ConfirmBriefStep, or null — the plan step plans from it (Lane E). */
  proposal: BriefProposal | null;
}

/** Step two: bind it to something, or deliberately do not. */
function BriefStep({
  brand, onBack, onPick,
}: {
  brand: StudioBrand;
  onBack: () => void;
  onPick: (ctx: BriefContext) => void;
}) {
  const { data: deliverables, isLoading } = useDeliverables(brand.brandId);
  const [brief, setBrief] = useState<string | null>(null);
  /** Her uploaded brief's path (PR 6, 6d) — kept for the plan row; with the flags on, read too (Lane E). */
  const [briefFilePath, setBriefFilePath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** A direction tool's answer, held as data until she confirms it line by line (PR 7). */
  const [proposal, setProposal] = useState<BriefProposal | null>(null);
  /** Two or three directions from propose_campaign, until she picks one. */
  const [proposals, setProposals] = useState<BriefProposal[] | null>(null);
  /** A moment she confirmed — the brief as it stands, or what ideas are built on (the stacking hook). */
  const [moment, setMoment] = useState<BriefProposal | null>(null);
  const [busy, setBusy] = useState<"moment" | "reference" | "ideas" | null>(null);
  const [ask, setAsk] = useState("");
  const [askDate, setAskDate] = useState("");
  const [reference, setReference] = useState("");
  /** The trend pillar's honest answer, from the server — null until it arrives, or when the door is off. */
  const [trend, setTrend] = useState<string | null>(null);

  // Flags off: no doors at all, and the screen below is today's, byte for byte (the control cell).
  const pillars = pillarsFor({ plansOntoBoard: PLANS_ONTO_BOARD, moments: STUDIO_DIRECTION_MOMENTS });
  const showTrend = pillars.doors.includes("trend");
  useEffect(() => {
    if (!showTrend) return;
    let live = true;
    trendSignal()
      .then((t) => { if (live) setTrend(t.reason); })
      .catch(() => { /* the door is simply not drawn */ });
    return () => { live = false; };
  }, [showTrend]);

  const ctx = (p: BriefProposal | null, path: string | null = briefFilePath): BriefContext => {
    const story = p ? valueAt(p.brief, "story") : null;
    return {
      campaign: typeof story === "string" && story.trim() ? story.trim() : `Something for ${brand.name}`,
      deliverable: null,
      briefFilePath: path,
      proposal: p,
    };
  };
  /** Where every tool's answer lands: the confirm step when there is something to confirm, else straight on. */
  const land = (p: BriefProposal, path: string | null = briefFilePath) =>
    needsConfirm(p) ? setProposal(p) : onPick(ctx(p, path));
  const fail = (e: unknown, fallback: string) =>
    setUploadError(e instanceof Error ? e.message : fallback);

  const onMoment = async () => {
    if (!ask.trim()) return;
    setBusy("moment");
    setUploadError(null);
    try {
      land(await researchMoment({ ask: ask.trim(), brand: brand.name, date: askDate.trim() || null }));
    } catch (e) {
      fail(e, "Couldn't find a moment.");
    } finally {
      setBusy(null);
    }
  };
  const onReference = async () => {
    const source = referenceSourceFor(reference);
    if (!source) return;
    setBusy("reference");
    setUploadError(null);
    try {
      // The stored reference row's id is answered by the server and NOT collected here (PR 10, R-6): nothing
      // consumed it. Card "brand-post reference asset → plan reference" (PR 14) wires it where ref_N lands.
      land((await decomposeReference(source)).proposal);
    } catch (e) {
      fail(e, "Couldn't read that reference.");
    } finally {
      setBusy(null);
    }
  };
  const onIdeas = async () => {
    setBusy("ideas");
    setUploadError(null);
    try {
      // A confirmed moment stacks into the ask — through her confirm tap only (toPriorContext).
      const r = await proposeCampaign({
        objective: "showcase-product",
        brand: brand.name,
        priorContext: moment ? toPriorContext(moment, { confirmed: true }) : null,
      });
      setProposals(r.proposals);
    } catch (e) {
      fail(e, "Couldn't find ideas.");
    } finally {
      setBusy(null);
    }
  };

  if (proposal) {
    return (
      <ConfirmBriefStep
        proposal={proposal}
        brandName={brand.name}
        onBack={() => setProposal(null)}
        onConfirm={(p) => {
          // A confirmed moment waits here: the brief as it stands, or what ideas are built on.
          if (isMoment(p) && !moment) {
            setMoment(p);
            setProposal(null);
          } else onPick(ctx(p));
        }}
      />
    );
  }
  if (proposals) {
    return (
      <ProposalsStep
        proposals={proposals}
        brandName={brand.name}
        onBack={() => setProposals(null)}
        onPick={(p) => {
          setProposals(null);
          land(p);
        }}
      />
    );
  }
  const onUpload = async () => {
    // Flags off: today's stub, exactly as before.
    if (!PLANS_ONTO_BOARD) {
      setBrief(`${brand.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_brief.pdf`);
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      // Lane E: the brief is READ, not only stored — the signed mint first (the production path), the
      // raw route only when this runtime cannot sign; either way the same kind of path reaches
      // summarize_brief, and the confirm step cannot tell which served.
      const picked = await pickBriefPdf();
      if (picked) {
        const { proposal: read, briefFilePath: path } = await summarizeBriefPicked(picked);
        setBriefFilePath(path);
        setBrief("Your brief");
        land(read, path);
      }
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Couldn't read that brief.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.topbar}>
        <HapticPressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="chevron-left" size={22} color={Colors.light.text} />
        </HapticPressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.topTitle}>What is it for?</Text>
          <Text style={styles.topSub}>{brand.name}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {isLoading ? <ActivityIndicator style={{ marginTop: 30 }} color={Colors.light.primary} /> : null}

        {deliverables.length > 0 ? (
          <>
            <View style={styles.note}>
              <Feather name="zap" size={14} color={Colors.light.primary} />
              <Text style={styles.noteTxt}>From your mail and contracts.</Text>
            </View>
            {deliverables.map((d) => (
              <DeliverableRow
                key={d.id}
                d={d}
                onPress={() =>
                  // The deliverable's id travels now (PR 6, 6d) — the plan row names the deal it is for.
                  onPick({ campaign: d.campaign, deliverable: { id: d.id, campaign: d.campaign }, briefFilePath, proposal: null })
                }
              />
            ))}
          </>
        ) : !isLoading ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nothing open for {brand.name}</Text>
            <Text style={styles.emptyBody}>
              Nothing in your mail or contracts names a deliverable for them. You can still make the
              post — it just will not count against a deal until you link it.
            </Text>
          </View>
        ) : null}

        {/* Door two. Reading a brief is how a deliverable gets its detail when the mail parser only
            half-knew it. */}
        {brief ? (
          <View style={styles.briefRead}>
            <Feather name="zap" size={14} color={Colors.light.primary} />
            <Text style={styles.briefTxt}>
              <Text style={styles.briefBold}>{brief}</Text> — read it. Nothing open for {brand.name} to
              match it to, so it stands on its own.
            </Text>
          </View>
        ) : (
          <HapticPressable
            style={styles.door}
            onPress={onUpload}
            disabled={uploading}
            accessibilityRole="button"
            accessibilityLabel="Upload a brief"
          >
            <View style={styles.doorIcon}>
              <Feather name="upload" size={17} color={Colors.light.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.doorTitle}>Upload a brief</Text>
              <Text style={styles.doorSub}>
                {uploading ? "Uploading…" : "PDF or deck — I read it and tell you what it matches"}
              </Text>
            </View>
            <Feather name="chevron-right" size={15} color={Colors.light.tabIconDefault} />
          </HapticPressable>
        )}

        {/* The four pillars (PR 7, Lane E) — drawn only with the flags on; each lands on the same
            ConfirmBriefStep. A moment: one live search, the date hers. A reference: pasted words or a
            link to an image, read by the reference engine. Ideas: two or three directions, built on a
            confirmed moment when there is one. Trends: the honest answer from the server, not a list. */}
        {moment ? (
          <View style={styles.built}>
            <Feather name="zap" size={14} color={Colors.light.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.builtTitle}>Built on: {String(valueAt(moment.brief, "story") ?? "a moment")}</Text>
              <HapticPressable
                onPress={() => onPick(ctx(moment))}
                accessibilityRole="button"
                accessibilityLabel="Use this moment as the brief"
              >
                <Text style={styles.builtLink}>Use this moment as the brief</Text>
              </HapticPressable>
            </View>
          </View>
        ) : null}

        {pillars.doors.includes("moment") && !moment ? (
          <View style={styles.pillar}>
            <Text style={styles.doorTitle}>Find a moment</Text>
            <Text style={styles.doorSub}>A fixture, a milestone, a week — searched live. The date is yours to add.</Text>
            <TextInput
              style={styles.field}
              value={ask}
              onChangeText={setAsk}
              placeholder="Our next home derby"
              placeholderTextColor={Colors.light.textMuted}
              maxLength={300}
              accessibilityLabel="What moment"
            />
            <TextInput
              style={styles.field}
              value={askDate}
              onChangeText={setAskDate}
              placeholder="When, if you know — “Saturday 4 Oct”"
              placeholderTextColor={Colors.light.textMuted}
              maxLength={60}
              accessibilityLabel="When"
            />
            <HapticPressable
              style={[styles.secondary, (busy !== null || !ask.trim()) && styles.secondaryOff]}
              onPress={onMoment}
              disabled={busy !== null || !ask.trim()}
              accessibilityRole="button"
              accessibilityLabel="Find it"
            >
              <Text style={styles.secondaryTxt}>{busy === "moment" ? "Searching…" : "Find it"}</Text>
            </HapticPressable>
          </View>
        ) : null}

        {pillars.doors.includes("reference") ? (
          <View style={styles.pillar}>
            <Text style={styles.doorTitle}>A reference</Text>
            <Text style={styles.doorSub}>Paste the words, or a link to an image. I read what it is going for.</Text>
            <TextInput
              style={[styles.field, styles.fieldTall]}
              value={reference}
              onChangeText={setReference}
              placeholder="Paste a brief, or https://…/look.jpg"
              placeholderTextColor={Colors.light.textMuted}
              multiline
              maxLength={2000}
              accessibilityLabel="A reference"
            />
            <HapticPressable
              style={[styles.secondary, (busy !== null || !referenceSourceFor(reference)) && styles.secondaryOff]}
              onPress={onReference}
              disabled={busy !== null || !referenceSourceFor(reference)}
              accessibilityRole="button"
              accessibilityLabel="Read it"
            >
              <Text style={styles.secondaryTxt}>{busy === "reference" ? "Reading…" : "Read it"}</Text>
            </HapticPressable>
          </View>
        ) : null}

        {pillars.doors.includes("ideas") ? (
          <HapticPressable
            style={styles.door}
            onPress={onIdeas}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel={moment ? "Ideas built on this moment" : "Ask for ideas"}
          >
            <View style={styles.doorIcon}>
              <Feather name="compass" size={17} color={Colors.light.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.doorTitle}>{moment ? "Ideas built on this moment" : "Ask for ideas"}</Text>
              <Text style={styles.doorSub}>
                {busy === "ideas" ? "Thinking…" : "Two or three directions, from what you have shot"}
              </Text>
            </View>
            <Feather name="chevron-right" size={15} color={Colors.light.tabIconDefault} />
          </HapticPressable>
        ) : null}

        {showTrend && trend ? (
          <View style={styles.trendRow} accessibilityLabel="Trends not available">
            <Feather name="trending-up" size={14} color={Colors.light.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.trendTxt}>Trends — not available yet</Text>
              <Text style={styles.trendSub}>{trend}</Text>
            </View>
          </View>
        ) : null}

        {uploadError ? <Text style={styles.emptyBody}>{uploadError}</Text> : null}

        {/* Door three: quiet on purpose. */}
        <HapticPressable
          style={styles.skip}
          onPress={() => onPick({ campaign: `Something for ${brand.name}`, deliverable: null, briefFilePath, proposal: null })}
          accessibilityRole="button"
          accessibilityLabel="Skip for now, link it later"
        >
          <Text style={styles.skipTxt}>Skip for now — link it later</Text>
        </HapticPressable>
      </ScrollView>
    </SafeAreaView>
  );
}

/** Two or three directions from propose_campaign: she picks one, and it lands on the confirm step. */
function ProposalsStep({
  proposals, brandName, onBack, onPick,
}: {
  proposals: BriefProposal[];
  brandName: string;
  onBack: () => void;
  onPick: (p: BriefProposal) => void;
}) {
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.topbar}>
        <HapticPressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="chevron-left" size={22} color={Colors.light.text} />
        </HapticPressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.topTitle}>Pick a direction</Text>
          <Text style={styles.topSub}>{brandName}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {proposals.map((p, i) => {
          const c = p.extras.concept;
          const story = valueAt(p.brief, "story");
          const title = c?.angle ?? (typeof story === "string" ? story : `Direction ${i + 1}`);
          return (
            <HapticPressable
              key={`${i}-${title}`}
              style={styles.proposal}
              onPress={() => onPick(p)}
              accessibilityRole="button"
              accessibilityLabel={`Use: ${title}`}
            >
              {c ? <Text style={styles.proposalKind}>{c.feeling.toUpperCase()}</Text> : null}
              <Text style={styles.proposalAngle}>{title}</Text>
              {c ? <Text style={styles.proposalLine}>{c.line}</Text> : null}
            </HapticPressable>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

function DeliverableRow({ d, onPress }: { d: Deliverable; onPress: () => void }) {
  return (
    <HapticPressable
      style={styles.deliv}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${d.campaign}, ${d.format}, ${d.delivered} of ${d.total} delivered`}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.delivTitle}>{d.campaign}</Text>
        <Text style={styles.delivSub}>{d.brandName} · {d.format}</Text>
        <View style={styles.delivTags}>
          <View style={[styles.tag, d.optional ? null : styles.tagDue]}>
            <Text style={styles.tagTxt}>{d.optional ? "Optional" : `Due ${d.dueOn ?? "—"}`}</Text>
          </View>
          <View style={styles.tag}>
            <Text style={styles.tagTxt}>{d.delivered} of {d.total} delivered</Text>
          </View>
        </View>
      </View>
      <Feather name="chevron-right" size={16} color={Colors.light.tabIconDefault} />
    </HapticPressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  topbar: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: Spacing.xl, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: Colors.light.border,
  },
  topTitle: { fontFamily: Fonts.bodyBold, fontSize: 15.5, fontWeight: "700", color: Colors.light.text },
  topSub: { fontFamily: Fonts.body, fontSize: 11, color: Colors.light.textMuted },
  body: { padding: Spacing.xl, paddingBottom: 26 },

  brandRow: {
    flexDirection: "row", alignItems: "center", gap: 11, marginBottom: 8,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 15, padding: 12,
  },
  brandName: { fontFamily: Fonts.bodyBold, fontSize: 14.5, fontWeight: "700", color: Colors.light.text },
  brandSub: { fontFamily: Fonts.body, fontSize: 11.5, color: Colors.light.textMuted, marginTop: 1 },

  note: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  noteTxt: { flex: 1, fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted },

  deliv: {
    flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 15, padding: 12,
  },
  delivTitle: { fontFamily: Fonts.bodyBold, fontSize: 14, fontWeight: "700", color: Colors.light.text },
  delivSub: { fontFamily: Fonts.body, fontSize: 11.5, color: Colors.light.textMuted, marginTop: 2 },
  delivTags: { flexDirection: "row", gap: 6, marginTop: 8 },
  tag: {
    borderRadius: 99, paddingHorizontal: 8, paddingVertical: 3,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  tagDue: { backgroundColor: Colors.light.warningLight },
  tagTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, fontWeight: "600", color: Colors.light.textSecondary },

  door: {
    flexDirection: "row", alignItems: "center", gap: 11, marginTop: 12,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 15, padding: 12,
  },
  doorIcon: {
    width: 34, height: 34, borderRadius: 10, backgroundColor: Colors.light.primaryLight,
    alignItems: "center", justifyContent: "center",
  },
  doorTitle: { fontFamily: Fonts.bodyBold, fontSize: 14, fontWeight: "700", color: Colors.light.text },
  doorSub: { fontFamily: Fonts.body, fontSize: 11.5, color: Colors.light.textMuted, marginTop: 1 },

  briefRead: {
    flexDirection: "row", alignItems: "flex-start", gap: 9, marginTop: 12,
    backgroundColor: Colors.light.primaryLight, borderWidth: 1, borderColor: Colors.light.primary,
    borderRadius: 15, padding: 12,
  },
  briefTxt: { flex: 1, fontFamily: Fonts.body, fontSize: 12, lineHeight: 17, color: Colors.light.text },
  briefBold: { fontFamily: Fonts.bodyBold, fontWeight: "700" },

  pillar: {
    marginTop: 12, gap: 8,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 15, padding: 12,
  },
  field: {
    fontFamily: Fonts.body, fontSize: 14, color: Colors.light.text,
    borderWidth: 1, borderColor: Colors.light.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 9, backgroundColor: Colors.light.backgroundRoot,
  },
  fieldTall: { minHeight: 76, textAlignVertical: "top" },
  secondary: {
    alignSelf: "flex-start", minWidth: 120, height: 36, paddingHorizontal: 16, borderRadius: 99,
    alignItems: "center", justifyContent: "center", backgroundColor: Colors.light.primary,
  },
  secondaryOff: { opacity: 0.4 },
  secondaryTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 13, fontWeight: "600", color: Colors.light.buttonText },
  built: {
    flexDirection: "row", alignItems: "flex-start", gap: 9, marginTop: 12,
    backgroundColor: Colors.light.primaryLight, borderWidth: 1, borderColor: Colors.light.primary,
    borderRadius: 15, padding: 12,
  },
  builtTitle: { fontFamily: Fonts.bodyBold, fontSize: 13, fontWeight: "700", color: Colors.light.text },
  builtLink: { fontFamily: Fonts.bodySemiBold, fontSize: 12.5, fontWeight: "600", color: Colors.light.primary, marginTop: 6 },
  trendRow: { flexDirection: "row", alignItems: "flex-start", gap: 9, marginTop: 12, paddingHorizontal: 4 },
  trendTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 12.5, fontWeight: "600", color: Colors.light.textMuted },
  trendSub: { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16, color: Colors.light.textMuted, marginTop: 2 },
  proposal: {
    marginBottom: 10, gap: 4,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 15, padding: 14,
  },
  proposalKind: { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, fontWeight: "600", letterSpacing: 0.5, color: Colors.light.textMuted },
  proposalAngle: { fontFamily: Fonts.bodyBold, fontSize: 15, fontWeight: "700", color: Colors.light.text },
  proposalLine: { fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18, color: Colors.light.textSecondary },

  skip: { alignItems: "center", paddingVertical: 14, marginTop: 4 },
  skipTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 13, fontWeight: "600", color: Colors.light.textMuted },

  empty: { alignItems: "center", paddingTop: 26, paddingHorizontal: 10 },
  emptyTitle: { fontFamily: Fonts.bodyBold, fontSize: 15, fontWeight: "700", color: Colors.light.text },
  emptyBody: {
    fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18, color: Colors.light.textMuted,
    marginTop: 5, textAlign: "center", maxWidth: 280,
  },
});
