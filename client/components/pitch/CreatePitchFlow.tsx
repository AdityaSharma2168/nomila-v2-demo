import React, { useMemo, useState } from "react";
import {
  Modal, View, Text, Pressable, TextInput, ScrollView, StyleSheet, ActivityIndicator, Image, SafeAreaView,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useAthleteBrands, useResolveBrand, useSearchBrands, type GlobalBrand } from "../../hooks/use-card";
import { useMyPitches, type PitchInsights, type Pitch } from "../../hooks/use-pitches";
import { useBuildStream, useInsightsStream, RESEARCH_STEPS } from "../../hooks/use-build-stream";
import { BuildTimeline } from "./BuildTimeline";
import { PITCH_STATUS, pitchStatusLabel } from "./pitchStatus";
import { brandLogoUri } from "../../lib/brand-logo";
import { Brand, Colors, Fonts, Spacing } from "../../constants/theme";

type Phase = "search" | "confirm" | "researching" | "angle" | "building";

interface Resolved {
  brandId: number; name: string; logo: string | null; domain: string | null;
  category: string | null; tier: string | null; audience: string | null; description: string | null;
}

const STEP_GROUP: Record<Phase, 0 | 1 | 2> = { search: 0, confirm: 0, researching: 1, angle: 1, building: 2 };
const GROUPS = ["Confirm", "Angle", "Build"];

export function CreatePitchFlow({
  visible, athleteId, onClose, onCreated, initialBrand,
}: {
  visible: boolean;
  athleteId: string | undefined;
  onClose: () => void;
  onCreated: (brandId: number, brandName: string) => void;
  // When provided (deep-linked from a deal), seed the resolved brand and skip the
  // search phase — the flow opens straight on "confirm" for that brand. Absent
  // everywhere else (Studio), so the search-first behavior is 100% unchanged.
  initialBrand?: {
    brandId: number; name: string;
    logo?: string | null; domain?: string | null; category?: string | null; tier?: string | null;
  };
}) {
  const { brands } = useAthleteBrands(athleteId);
  const { pitches } = useMyPitches(athleteId);
  const resolveBrand = useResolveBrand();
  const research = useInsightsStream(athleteId);
  const build = useBuildStream(athleteId);

  // Seed straight to "confirm" for a deep-linked brand; otherwise start on search
  // (lazy initializers, so an absent initialBrand is byte-identical to before).
  const [phase, setPhase] = useState<Phase>(() => (initialBrand ? "confirm" : "search"));
  const [q, setQ] = useState("");
  const [resolved, setResolved] = useState<Resolved | null>(() =>
    initialBrand
      ? {
          brandId: initialBrand.brandId, name: initialBrand.name,
          logo: initialBrand.logo ?? null, domain: initialBrand.domain ?? null,
          category: initialBrand.category ?? null, tier: initialBrand.tier ?? null,
          audience: null, description: null,
        }
      : null,
  );
  const [insights, setInsights] = useState<PitchInsights | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reset = () => {
    setPhase("search"); setQ(""); setResolved(null); setInsights(null); setSelected(new Set());
  };
  const close = () => { build.cancel(); reset(); onClose(); };

  const { results: globalResults } = useSearchBrands(q);
  const pipelineIds = useMemo(() => new Set(brands.map((b) => b.brandId)), [brands]);
  const pitchByBrand = useMemo(() => new Map(pitches.map((p) => [p.brandId, p])), [pitches]);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? brands.filter((b) => b.name.toLowerCase().includes(n)) : brands;
  }, [brands, q]);
  const globalOther = useMemo(() => globalResults.filter((g) => !pipelineIds.has(g.brandId)), [globalResults, pipelineIds]);
  const exactMatch = [...brands, ...globalResults].some((b) => b.name.toLowerCase() === q.trim().toLowerCase());

  const pickExisting = (b: (typeof brands)[number]) => {
    setResolved({ brandId: b.brandId, name: b.name, logo: b.logoUrl, domain: b.domain, category: b.category, tier: b.tier, audience: null, description: null });
    setPhase("confirm");
  };

  // A pipeline brand that already has a pitch opens it (never duplicate); otherwise it creates.
  const tapPipeline = (b: (typeof brands)[number]) => {
    if (pitchByBrand.has(b.brandId)) { reset(); onCreated(b.brandId, b.name); }
    else pickExisting(b);
  };

  // A known brand from the shared store — already researched, so skip resolve, go straight to confirm.
  const pickGlobal = (g: GlobalBrand) => {
    setResolved({ brandId: g.brandId, name: g.name, logo: g.logoUrl, domain: g.domain, category: g.category, tier: g.tier, audience: null, description: null });
    setPhase("confirm");
  };

  const addNew = async () => {
    const name = q.trim();
    if (!name) return;
    try {
      const r = await resolveBrand.mutateAsync({ name });
      setResolved({ brandId: r.brandId, name: r.name, logo: r.logo, domain: r.domain, category: r.category, tier: r.tier, audience: r.audience, description: r.description });
      setPhase("confirm");
    } catch { /* surfaced by mutation state */ }
  };

  const confirmYes = async () => {
    if (!resolved) return;
    setPhase("researching");
    const ins = await research.run(resolved.brandId);
    if (ins) {
      const sel = new Set<string>();
      ins.angles.forEach((a) => sel.add(a.key));
      ins.campaigns.forEach((_, i) => sel.add(`c:${i}`));
      setInsights(ins); setSelected(sel); setPhase("angle");
    } else {
      buildNow();
    }
  };

  const buildNow = async () => {
    if (!resolved) return;
    setPhase("building");
    // What she kept on the angle step (fit angles + campaigns) goes to the concept — it used to be dropped here.
    const focus = insights
      ? [
          ...insights.angles.filter((a) => selected.has(a.key)).map((a) => `${a.title}: ${a.text}`),
          ...insights.campaigns.filter((_, i) => selected.has(`c:${i}`)).map((c) => `Their campaign: ${c}`),
        ]
      : [];
    const ok = await build.run(resolved.brandId, focus);
    if (ok) { const { brandId, name } = resolved; reset(); onCreated(brandId, name); }
  };

  const toggle = (key: string) =>
    setSelected((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close} presentationStyle="pageSheet">
      <SafeAreaView style={styles.safe}>
        {/* top bar + stepper */}
        <View style={styles.top}>
          <Pressable onPress={close} hitSlop={10} style={styles.x}><Feather name="x" size={22} color={Colors.light.text} /></Pressable>
          <View style={styles.stepper}>
            {GROUPS.map((g, i) => (
              <View key={g} style={styles.stepDotWrap}>
                <View style={[styles.stepDot, i === STEP_GROUP[phase] && styles.stepDotOn, i < STEP_GROUP[phase] && styles.stepDotDone]} />
              </View>
            ))}
          </View>
          <View style={styles.x} />
        </View>

        {phase === "search" && (
          <View style={styles.body}>
            <View>
              <Text style={styles.h1}>Who are you pitching?</Text>
              <Text style={styles.h1sub}>Mila rebuilds your card for them — their audience, your fit.</Text>
            </View>
            <View style={styles.search}>
              <Feather name="search" size={16} color={Colors.light.textMuted} />
              <TextInput
                value={q} onChangeText={setQ} placeholder="Search brands, or add a new one"
                placeholderTextColor={Colors.light.textMuted} style={styles.searchInput} autoFocus autoCapitalize="words"
              />
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
              {q.trim() && !exactMatch ? (
                <Pressable style={styles.addRow} onPress={addNew} disabled={resolveBrand.isPending}>
                  <View style={styles.addIco}>
                    {resolveBrand.isPending ? <ActivityIndicator size="small" color={Colors.light.primary} /> : <Feather name="plus" size={18} color={Colors.light.primary} />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.addName}>Add “{q.trim()}”</Text>
                    <Text style={styles.addSub}>We’ll research them and build your deck</Text>
                  </View>
                </Pressable>
              ) : null}

              {/* One merged, ranked result list — affiliated (warmest first) then suggested,
                  each row tagged so it's clear which is which. */}
              {filtered.map((b) => {
                const p = pitchByBrand.get(b.brandId);
                return (
                  <BrandRow
                    key={`p${b.brandId}`}
                    logo={brandLogoUri(b.logoUrl, b.domain)}
                    name={b.name}
                    desc={b.description ?? ([b.category, b.tier].filter(Boolean).join(" · ") || null)}
                    tag={p ? <StatusChip pitch={p} /> : <MutedTag icon="inbox" label="In your inbox" />}
                    onPress={() => tapPipeline(b)}
                  />
                );
              })}
              {globalOther.map((g) => (
                <BrandRow
                  key={`g${g.brandId}`}
                  logo={brandLogoUri(g.logoUrl, g.domain)}
                  name={g.name}
                  desc={g.description ?? ([g.category, g.tier].filter(Boolean).join(" · ") || null)}
                  tag={<MutedTag icon="globe" label="Suggested" />}
                  onPress={() => pickGlobal(g)}
                />
              ))}
            </ScrollView>
          </View>
        )}

        {phase === "confirm" && resolved && (
          <View style={styles.body}>
            <Text style={styles.h1}>Is this the brand?</Text>
            <View style={styles.confirmCard}>
              <View style={styles.confirmHead}>
                {brandLogoUri(resolved.logo, resolved.domain) ? <Image source={{ uri: brandLogoUri(resolved.logo, resolved.domain)! }} style={styles.confirmLogo} /> : <View style={[styles.confirmLogo, styles.brandLogoPh]}><Text style={styles.brandInit}>{resolved.name[0]}</Text></View>}
                <View style={{ flex: 1 }}>
                  <Text style={styles.confirmName}>{resolved.name}</Text>
                  {resolved.category ? <Text style={styles.confirmCat}>{resolved.category}{resolved.tier ? ` · ${resolved.tier}` : ""}</Text> : null}
                </View>
              </View>
              {resolved.description ? <Text style={styles.confirmDesc}>{resolved.description}</Text> : null}
              {resolved.audience ? <Fact icon="users" text={resolved.audience} /> : null}
              <View style={styles.webChip}><Feather name="globe" size={11} color={Colors.light.textMuted} /><Text style={styles.webChipTxt}>Found on the web</Text></View>
            </View>
            <View style={styles.actions}>
              <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => { setResolved(null); setPhase("search"); }}>
                <Text style={styles.btnGhostTxt}>Not quite</Text>
              </Pressable>
              <Pressable style={[styles.btn, styles.btnPrimary]} onPress={confirmYes}>
                <Text style={styles.btnPrimaryTxt}>Yes, that’s them</Text>
              </Pressable>
            </View>
          </View>
        )}

        {phase === "researching" && resolved && (
          <View style={styles.body}>
            <Text style={styles.h1}>Researching {resolved.name}</Text>
            <View style={{ paddingVertical: 24 }}>
              <BuildTimeline steps={RESEARCH_STEPS} stepState={research.stepState} />
            </View>
          </View>
        )}

        {phase === "angle" && insights && (
          <View style={styles.body}>
            <Text style={styles.h1}>What should we build around?</Text>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 18, paddingBottom: 12 }}>
              {insights.campaigns.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={styles.groupLabel}>MOMENTS TO RIDE</Text>
                  {insights.campaigns.map((c, i) => (
                    <ToggleRow key={`c:${i}`} on={selected.has(`c:${i}`)} onPress={() => toggle(`c:${i}`)} title={c} />
                  ))}
                </View>
              )}
              {insights.angles.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={styles.groupLabel}>WHY YOU FIT {insights.brand.name.toUpperCase()}</Text>
                  {insights.angles.map((a) => (
                    <ToggleRow key={a.key} on={selected.has(a.key)} onPress={() => toggle(a.key)} title={a.title} sub={a.text} />
                  ))}
                </View>
              )}
            </ScrollView>
            <View style={styles.actions}>
              <Pressable style={[styles.btn, styles.btnGhost]} onPress={buildNow}>
                <Text style={styles.btnGhostTxt}>Skip — just build it</Text>
              </Pressable>
              <Pressable style={[styles.btn, styles.btnPrimary]} onPress={buildNow}>
                <Text style={styles.btnPrimaryTxt}>Build with these ({selected.size})</Text>
              </Pressable>
            </View>
          </View>
        )}

        {phase === "building" && resolved && (
          <View style={styles.body}>
            <Text style={styles.h1}>Building your {resolved.name} pitch</Text>
            <View style={{ paddingVertical: 24 }}>
              <BuildTimeline stepState={build.stepState} />
            </View>
            {build.error ? (
              <View style={styles.actions}>
                <Pressable style={[styles.btn, styles.btnGhost]} onPress={close}><Text style={styles.btnGhostTxt}>Close</Text></Pressable>
                <Pressable style={[styles.btn, styles.btnPrimary]} onPress={buildNow}><Text style={styles.btnPrimaryTxt}>Try again</Text></Pressable>
              </View>
            ) : null}
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function Fact({ icon, text }: { icon: React.ComponentProps<typeof Feather>["name"]; text: string }) {
  return (
    <View style={styles.fact}>
      <Feather name={icon} size={13} color={Colors.light.textMuted} />
      <Text style={styles.factTxt}>{text}</Text>
    </View>
  );
}

function BrandRow({
  logo, name, desc, tag, onPress,
}: {
  logo: string | null;
  name: string;
  desc: string | null;
  tag: React.ReactNode;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.brandRow} onPress={onPress}>
      {logo
        ? <Image source={{ uri: logo }} style={styles.brandLogo} />
        : <View style={[styles.brandLogo, styles.brandLogoPh]}><Text style={styles.brandInit}>{name[0]}</Text></View>}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.rowTop}>
          <Text style={styles.brandName} numberOfLines={1}>{name}</Text>
          {tag}
        </View>
        {desc ? <Text style={styles.brandCat} numberOfLines={1}>{desc}</Text> : null}
      </View>
      <Feather name="chevron-right" size={18} color={Colors.light.textMuted} />
    </Pressable>
  );
}

function MutedTag({ icon, label }: { icon: React.ComponentProps<typeof Feather>["name"]; label: string }) {
  return (
    <View style={styles.mutedTag}>
      <Feather name={icon} size={10} color={Colors.light.textMuted} />
      <Text style={styles.mutedTagTxt}>{label}</Text>
    </View>
  );
}

function StatusChip({ pitch }: { pitch: Pitch }) {
  return (
    <View style={styles.statusChip}>
      <View style={[styles.statusDot, { backgroundColor: PITCH_STATUS[pitch.status].color }]} />
      <Text style={styles.statusChipTxt}>{pitchStatusLabel(pitch)}</Text>
    </View>
  );
}

function ToggleRow({ on, onPress, title, sub }: { on: boolean; onPress: () => void; title: string; sub?: string }) {
  return (
    <Pressable style={[styles.toggleRow, on && styles.toggleRowOn]} onPress={onPress}>
      <View style={[styles.check, on && styles.checkOn]}>{on ? <Feather name="check" size={12} color="#fff" /> : null}</View>
      <View style={{ flex: 1 }}>
        <Text style={styles.toggleTitle}>{title}</Text>
        {sub ? <Text style={styles.toggleSub}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  top: { flexDirection: "row", alignItems: "center", paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  x: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  stepper: { flex: 1, flexDirection: "row", justifyContent: "center", gap: 8 },
  stepDotWrap: {},
  stepDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.light.border },
  stepDotOn: { backgroundColor: Colors.light.primary, width: 22 },
  stepDotDone: { backgroundColor: Colors.light.primary },
  body: { flex: 1, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, gap: 16 },
  centered: { alignItems: "center", justifyContent: "center", gap: 12 },
  h1: { fontFamily: Fonts.display, fontSize: 24, fontWeight: "800", letterSpacing: -0.4, color: Colors.light.text },
  h1sub: { fontFamily: Fonts.body, fontSize: 13, color: Colors.light.textMuted, marginTop: 4, lineHeight: 18 },
  sectionLbl: { fontFamily: Fonts.bodyBold, fontSize: 11, letterSpacing: 1, color: Colors.light.textMuted, fontWeight: "700", marginTop: 16, marginBottom: 4 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  mutedTag: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: Colors.light.backgroundSecondary, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, flexShrink: 0 },
  mutedTagTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 10, fontWeight: "600", color: Colors.light.textMuted },
  statusChip: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: Colors.light.backgroundSecondary, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusChipTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, fontWeight: "700", color: Colors.light.textSecondary },
  search: {
    flexDirection: "row", alignItems: "center", gap: 9, height: 48, borderRadius: 999, paddingHorizontal: 15,
    backgroundColor: Colors.light.backgroundDefault, borderWidth: 1, borderColor: Colors.light.borderLight,
  },
  searchInput: { flex: 1, fontFamily: Fonts.body, fontSize: 15, color: Colors.light.text, padding: 0 },
  addRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  addIco: { width: 44, height: 44, borderRadius: 12, backgroundColor: Colors.light.primaryLight, alignItems: "center", justifyContent: "center" },
  addName: { fontFamily: Fonts.bodyBold, fontSize: 15, fontWeight: "700", color: Colors.light.primary },
  addSub: { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted, marginTop: 1 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  brandLogo: { width: 44, height: 44, borderRadius: 12, backgroundColor: Colors.light.backgroundSecondary },
  brandLogoPh: { alignItems: "center", justifyContent: "center" },
  brandInit: { fontFamily: Fonts.bodyBold, fontSize: 18, color: Colors.light.textSecondary },
  brandName: { fontFamily: Fonts.bodyBold, fontSize: 15, fontWeight: "700", color: Colors.light.text, flexShrink: 1 },
  brandCat: { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted, marginTop: 1 },
  readyChip: { backgroundColor: "#D1FAE5", borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  readyChipTxt: { fontFamily: Fonts.bodyBold, fontSize: 10, fontWeight: "800", color: "#047857", textTransform: "uppercase", letterSpacing: 0.4 },
  confirmCard: { backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border, borderRadius: 20, padding: 16, gap: 12 },
  confirmHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  confirmLogo: { width: 52, height: 52, borderRadius: 14, backgroundColor: Colors.light.backgroundSecondary },
  confirmName: { fontFamily: Fonts.display, fontSize: 20, fontWeight: "800", color: Colors.light.text },
  confirmCat: { fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: Colors.light.textMuted, marginTop: 2 },
  confirmDesc: { fontFamily: Fonts.body, fontSize: 13.5, lineHeight: 19, color: Colors.light.textSecondary },
  fact: { flexDirection: "row", alignItems: "center", gap: 8 },
  factTxt: { fontFamily: Fonts.body, fontSize: 13, color: Colors.light.textSecondary, flex: 1 },
  webChip: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", backgroundColor: Colors.light.backgroundSecondary, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  webChipTxt: { fontFamily: Fonts.bodyMedium, fontSize: 11, color: Colors.light.textMuted },
  researchTitle: { fontFamily: Fonts.heading, fontSize: 18, fontWeight: "700", color: Colors.light.text, marginTop: 4 },
  researchSub: { fontFamily: Fonts.body, fontSize: 13, color: Colors.light.textMuted, textAlign: "center" },
  groupLabel: { fontFamily: Fonts.bodyBold, fontSize: 11, letterSpacing: 1, color: Colors.light.textMuted, fontWeight: "700" },
  toggleRow: { flexDirection: "row", alignItems: "flex-start", gap: 11, backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border, borderRadius: 14, padding: 12 },
  toggleRowOn: { borderColor: Colors.light.primary },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: Colors.light.border, alignItems: "center", justifyContent: "center", marginTop: 1 },
  checkOn: { backgroundColor: Colors.light.primary, borderColor: Colors.light.primary },
  toggleTitle: { fontFamily: Fonts.bodySemiBold, fontSize: 14, fontWeight: "600", color: Colors.light.text },
  toggleSub: { fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 17, color: Colors.light.textMuted, marginTop: 2 },
  actions: { flexDirection: "row", gap: 10, paddingTop: 8, paddingBottom: Spacing.sm },
  btn: { flex: 1, height: 50, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  btnGhost: { backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border },
  btnGhostTxt: { fontFamily: Fonts.bodyBold, fontSize: 14, fontWeight: "700", color: Colors.light.text },
  btnPrimary: { backgroundColor: Colors.light.primary },
  btnPrimaryTxt: { fontFamily: Fonts.bodyBold, fontSize: 14, fontWeight: "700", color: "#fff" },
});
