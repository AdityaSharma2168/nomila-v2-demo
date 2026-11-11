import React, { useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Platform,
  Share,
  Alert,
  Linking,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as Clipboard from "expo-clipboard";
import Svg, { Circle } from "react-native-svg";
import { useCreateShare, type CreateShareInput } from "../../hooks/use-card";
import { Bold, Fonts, Colors, Spacing } from "../../constants/theme";

// ─── Share = the hand-off, not the workshop ────────────────────────────────────
// By the time you're here the card IS the card. Share answers only two things: who
// gets it, and will you know when they open it. Two doors:
//
//   Your public card  → { mode:live,     scope:public,    tailoring:generic }  (LIVE, forwardable)
//   Send to a brand   → { mode:snapshot, scope:recipient, gate?:email }        (SNAPSHOT, tracked)
//
// Tailoring a card FOR a brand is a make/edit act — it lives with Edit / the Pitches
// surface, never inside this sheet. (Redesign per Fable 5; see the cut list in git.)

interface ShareSheetProps {
  athleteId?:    string;
  athleteName?:  string | null;
  lookLabel?:    string;                 // e.g. "Nomila" — for the subtitle
  /** Cross-tab bridge (Opportunities "Tailor & send") — just opens the send door. */
  initialBrand?: { name?: string } | null;
  onClose:       () => void;
  onViewSignals?: () => void;
}

// The seal in ink: the ring colours paint the M.I.A. score and the logo only (one look, 23 Oct 2026).
const SEAL     = Bold.ink;
const ROSE_INK = "#C23577";

function haptic(style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light) {
  if (Platform.OS !== "web") Haptics.impactAsync(style).catch(() => {});
}

function firstNameOf(name?: string | null): string {
  const n = (name ?? "").trim();
  return n ? n.split(/\s+/)[0] : "them";
}

// The mark, three arcs from one anchor — the "public card" glyph.
function MarkArcs({ color, size = 22 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={5} cy={19} r={4}  fill="none" stroke={color} strokeWidth={1.8} />
      <Circle cx={5} cy={19} r={9.5} fill="none" stroke={color} strokeWidth={1.8} />
      <Circle cx={5} cy={19} r={15} fill="none" stroke={color} strokeWidth={1.8} />
    </Svg>
  );
}

// The wax seal — arcs of the mark inside a stamped ring.
function WaxSeal({ size = 44 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 44 44">
      <Circle cx={22} cy={22} r={20} fill="none" stroke={SEAL} strokeWidth={2} />
      <Circle cx={22} cy={22} r={15} fill="none" stroke={SEAL} strokeWidth={1} strokeDasharray="2.5 3" />
      <Circle cx={15} cy={29} r={4}  fill="none" stroke={SEAL} strokeWidth={1.6} />
      <Circle cx={15} cy={29} r={8}  fill="none" stroke={SEAL} strokeWidth={1.6} />
      <Circle cx={15} cy={29} r={12} fill="none" stroke={SEAL} strokeWidth={1.6} />
      <Circle cx={15} cy={29} r={1.6} fill={SEAL} />
    </Svg>
  );
}

// A native destination (Text / Email / More) — shares whatever `url` resolver returns.
function DestRow({ onKind }: { onKind: (k: "sms" | "mail" | "more") => void }) {
  const items: { k: "sms" | "mail" | "more"; icon: React.ComponentProps<typeof Feather>["name"]; label: string }[] = [
    { k: "sms",  icon: "message-circle", label: "Messages" },
    { k: "mail", icon: "mail",           label: "Mail" },
    { k: "more", icon: "share",          label: "More" },
  ];
  return (
    <View style={styles.dests}>
      {items.map((it) => (
        <Pressable key={it.k} style={styles.dest} onPress={() => { haptic(); onKind(it.k); }}>
          <View style={styles.destIcon}><Feather name={it.icon} size={18} color={Colors.light.text} /></View>
          <Text style={styles.destLabel}>{it.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function ShareSheet({ athleteId, athleteName, lookLabel, initialBrand, onClose, onViewSignals }: ShareSheetProps) {
  const createShare = useCreateShare(athleteId);

  const [door, setDoor] = useState<"none" | "brand">(initialBrand ? "brand" : "none");

  // The live public link — minted lazily, reused across copy/messages/mail/more.
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [publicBusy, setPublicBusy] = useState(false);

  // Send-to-a-person
  const [name,  setName]  = useState("");
  const [email, setEmail] = useState("");
  const [sealBusy, setSealBusy] = useState(false);
  const [sent, setSent] = useState<{ url: string; first: string; email: string } | null>(null);

  const [copied, setCopied] = useState(false);
  const flashCopied = () => { setCopied(true); setTimeout(() => setCopied(false), 1800); };

  const first = firstNameOf(name);
  const subtitle = [athleteName?.trim(), lookLabel ? `${lookLabel} look` : null].filter(Boolean).join(" · ");

  async function ensurePublicUrl(): Promise<string | null> {
    if (publicUrl) return publicUrl;
    if (!athleteId) return null;
    try {
      setPublicBusy(true);
      const res = await createShare.mutateAsync({ mode: "live", scope: "public", tailoring: "generic" });
      setPublicUrl(res.url);
      return res.url;
    } catch {
      Alert.alert("Couldn't create your link", "Please try again in a moment.");
      return null;
    } finally {
      setPublicBusy(false);
    }
  }

  const mailUrl = (to: string, url: string) => {
    const subject = encodeURIComponent(`${athleteName?.trim() ? athleteName.trim() + "'s" : "My"} Nomi Card`);
    const body    = encodeURIComponent(url);
    return `mailto:${to}?subject=${subject}&body=${body}`;
  };

  async function sendVia(kind: "sms" | "mail" | "more", url: string, to = "") {
    try {
      if (kind === "more") { await Share.share(Platform.OS === "ios" ? { url } : { message: url }); return; }
      if (kind === "mail") { await Linking.openURL(mailUrl(to, url)); return; }
      // sms
      const sep = Platform.OS === "ios" ? "&" : "?";
      await Linking.openURL(`sms:${to}${sep}body=${encodeURIComponent(url)}`);
    } catch { /* dismissed / unsupported */ }
  }

  async function copyPublic() {
    haptic(Haptics.ImpactFeedbackStyle.Medium);
    const url = await ensurePublicUrl();
    if (!url) return;
    await Clipboard.setStringAsync(url);
    flashCopied();
  }

  async function publicVia(kind: "sms" | "mail" | "more") {
    const url = await ensurePublicUrl();
    if (url) sendVia(kind, url);
  }

  async function seal() {
    if (!athleteId || sealBusy) return;
    haptic(Haptics.ImpactFeedbackStyle.Medium);
    const payload: CreateShareInput = {
      mode:      "snapshot",
      scope:     "recipient",
      tailoring: "generic",
      gate:      email.trim() ? "email" : "none",
    };
    if (name.trim())  payload.recipientName  = name.trim();
    if (email.trim()) payload.recipientEmail = email.trim();
    try {
      setSealBusy(true);
      const res = await createShare.mutateAsync(payload);
      setSent({ url: res.url, first, email: email.trim() });
    } catch {
      Alert.alert("Couldn't seal it", "Please try again in a moment.");
    } finally {
      setSealBusy(false);
    }
  }

  async function copySent() {
    if (!sent) return;
    haptic();
    await Clipboard.setStringAsync(sent.url);
    flashCopied();
  }

  const headerTitle = sent ? `Sealed for ${sent.first === "them" ? "them" : sent.first}` : "Share your card";

  return (
    <Modal transparent statusBarTranslucent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.container}>
        <Pressable style={styles.backdrop} onPress={onClose} />

        <View style={styles.sheet}>
          <View style={styles.handle} />

          {/* ── Header ── */}
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>{headerTitle}</Text>
              {!sent && !!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
            </View>
            <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Feather name="x" size={18} color="#9C968D" />
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* ═══ Success — the sealed link ═══ */}
            {sent ? (
              <View style={styles.block}>
                <View style={styles.sealHero}>
                  <WaxSeal size={52} />
                  <Text style={styles.sealHeroText}>
                    This link is {sent.first === "them" ? "theirs" : `${sent.first}'s`} alone — you'll know the moment
                    they open it, in Signals.
                  </Text>
                </View>

                <Pressable style={[styles.primary, copied && styles.primaryDone]} onPress={copySent}>
                  <Feather name={copied ? "check" : "link"} size={16} color="#FFFFFF" />
                  <Text style={styles.primaryText}>
                    {copied ? "Copied" : `Copy ${sent.first === "them" ? "the" : `${sent.first}'s`} link`}
                  </Text>
                </Pressable>

                <DestRow onKind={(k) => sendVia(k, sent.url, sent.email)} />

                {onViewSignals && (
                  <Pressable style={styles.quiet} onPress={() => { onClose(); onViewSignals(); }}>
                    <Feather name="activity" size={14} color={Colors.light.text} />
                    <Text style={styles.quietText}>Watch it in Signals</Text>
                  </Pressable>
                )}
              </View>
            ) : door === "brand" ? (
              /* ═══ Send to a brand — one screen: a name, maybe an email, then seal ═══ */
              <View style={styles.block}>
                <Pressable style={styles.back} onPress={() => { haptic(); setDoor("none"); }} hitSlop={8}>
                  <Feather name="chevron-left" size={16} color="#9C968D" />
                  <Text style={styles.backText}>Share options</Text>
                </Pressable>

                <Text style={styles.eyebrow}>Who's it going to?</Text>
                <TextInput
                  style={styles.input}
                  value={name}
                  onChangeText={setName}
                  placeholder="Their name — e.g. Sarah at Nike"
                  placeholderTextColor="#C5BFB8"
                  autoCapitalize="words"
                  autoFocus
                />
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Their email (optional)"
                  placeholderTextColor="#C5BFB8"
                  autoCapitalize="none"
                  keyboardType="email-address"
                />
                <Text style={styles.help}>Add it and we'll make sure it's really them when the card opens.</Text>

                <Pressable
                  style={[styles.primary, (sealBusy || !name.trim()) && styles.primaryDisabled]}
                  onPress={seal}
                  disabled={sealBusy || !name.trim()}
                >
                  {sealBusy ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <>
                      <Feather name="award" size={16} color="#FFFFFF" />
                      <Text style={styles.primaryText}>{name.trim() ? `Seal it for ${first}` : "Seal it"}</Text>
                    </>
                  )}
                </Pressable>
                <Text style={styles.sealNote}>
                  Sealed the moment you tap — {name.trim() ? `${first}'s` : "their"} copy won't change, even when you edit.
                </Text>
              </View>
            ) : (
              /* ═══ The two doors ═══ */
              <View style={styles.block}>
                {/* Door 1 — public / live, one tap to copy */}
                <View style={[styles.door, styles.doorHot]}>
                  <View style={[styles.doorIcon, styles.doorIconPink]}><MarkArcs color={Colors.light.primary} /></View>
                  <View style={styles.doorTx}>
                    <View style={styles.doorTitleRow}>
                      <Text style={styles.doorTitle}>Your public card</Text>
                      <View style={styles.tagLive}><Text style={styles.tagLiveText}>LIVE</Text></View>
                    </View>
                    <Text style={styles.doorSub}>One link, always your latest — edits show up for everyone who has it.</Text>
                  </View>
                  <Pressable style={[styles.copyChip, copied && styles.copyChipDone]} onPress={copyPublic} disabled={publicBusy}>
                    {publicBusy
                      ? <ActivityIndicator size="small" color={ROSE_INK} />
                      : <Text style={[styles.copyChipText, copied && styles.copyChipTextDone]}>{copied ? "Copied" : "Copy link"}</Text>}
                  </Pressable>
                </View>

                {/* Door 2 — send to a brand, sealed + tracked */}
                <Pressable style={styles.door} onPress={() => { haptic(); setDoor("brand"); }}>
                  <View style={[styles.doorIcon, styles.doorIconGold]}><WaxSeal size={26} /></View>
                  <View style={styles.doorTx}>
                    <View style={styles.doorTitleRow}>
                      <Text style={styles.doorTitle}>Send to a brand</Text>
                      <View style={styles.tagSnap}><Text style={styles.tagSnapText}>SNAPSHOT</Text></View>
                    </View>
                    <Text style={styles.doorSub}>Sealed as-is the moment you send — and you'll see every open.</Text>
                  </View>
                  <Feather name="chevron-right" size={18} color="#C5BFB8" />
                </Pressable>

                {/* Native destinations act on the public link */}
                <DestRow onKind={publicVia} />

                <Text style={styles.foot}>
                  <Text style={styles.footStrong}>Public stays live.</Text> A brand send is frozen the moment you seal it —
                  what they open is exactly what you sent.
                </Text>
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "flex-end" },
  backdrop:  { ...StyleSheet.absoluteFill, backgroundColor: "rgba(42,38,34,0.45)" },
  sheet: {
    backgroundColor:      Colors.light.card,
    borderTopLeftRadius:  24,
    borderTopRightRadius: 24,
    paddingTop:           10,
    maxHeight:            "90%",
  },
  handle: {
    width: 40, height: 4.5, backgroundColor: Colors.light.border,
    borderRadius: 3, alignSelf: "center", marginBottom: Spacing.md,
  },

  // Header
  header: {
    flexDirection:     "row",
    alignItems:        "flex-start",
    justifyContent:    "space-between",
    gap:               Spacing.md,
    paddingHorizontal: Spacing.xl,
    paddingBottom:     Spacing.lg,
  },
  headerText: { flex: 1, gap: 2 },
  title:      { fontFamily: Fonts.heading, fontSize: 18, color: Colors.light.text, letterSpacing: -0.3 },
  subtitle:   { fontFamily: Fonts.body, fontSize: 12, color: "#9C968D" },
  closeBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: Colors.light.backgroundDefault,
    alignItems: "center", justifyContent: "center", marginTop: 2,
  },

  // Scroll — flexShrink (NOT flex:1). The sheet is content-sized with maxHeight:90%; a flex:1
  // child inside a content-height parent collapses to ~0 in RN.
  scroll:        { flexShrink: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingBottom: 28 },
  block:         { gap: 12 },

  // ── The two doors ──
  door: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           12,
    borderWidth:   1.5,
    borderColor:   Colors.light.border,
    borderRadius:  20,
    backgroundColor: "#FFFFFF",
    padding:       14,
  },
  doorHot:      { borderColor: "#F7CEE1", backgroundColor: "#FFF9FC" },
  doorIcon:     { width: 46, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  doorIconPink: { backgroundColor: Colors.light.primaryLight },
  doorIconGold: { backgroundColor: "#F4ECDB" },
  doorTx:       { flex: 1, minWidth: 0, gap: 3 },
  doorTitleRow: { flexDirection: "row", alignItems: "center", gap: 7, flexWrap: "wrap" },
  doorTitle:    { fontFamily: Fonts.bodyBold, fontSize: 15, color: Colors.light.text },
  doorSub:      { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16, color: Colors.light.textSecondary },
  tagLive:      { backgroundColor: "#E7F4EC", borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  tagLiveText:  { fontFamily: Fonts.bodyBold, fontSize: 9, letterSpacing: 0.6, color: "#0E7A4D" },
  tagSnap:      { backgroundColor: "#F4ECDB", borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  tagSnapText:  { fontFamily: Fonts.bodyBold, fontSize: 9, letterSpacing: 0.6, color: "#C4850D" },
  copyChip: {
    flexShrink: 0,
    borderWidth: 1, borderColor: "#F7CEE1", backgroundColor: "#FFFFFF",
    borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8, minWidth: 74, alignItems: "center",
  },
  copyChipDone:     { backgroundColor: Colors.light.primary, borderColor: Colors.light.primary },
  copyChipText:     { fontFamily: Fonts.bodySemiBold, fontSize: 12, color: ROSE_INK },
  copyChipTextDone: { color: "#FFFFFF" },

  // Native destinations
  dests:     { flexDirection: "row", justifyContent: "center", gap: 26, paddingVertical: 8 },
  dest:      { alignItems: "center", gap: 5 },
  destIcon:  {
    width: 46, height: 46, borderRadius: 23, backgroundColor: Colors.light.backgroundDefault,
    alignItems: "center", justifyContent: "center",
  },
  destLabel: { fontFamily: Fonts.bodyMedium, fontSize: 10.5, color: Colors.light.textSecondary },

  foot:       { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 17, color: "#9C968D", textAlign: "center", marginTop: 2 },
  footStrong: { fontFamily: Fonts.bodySemiBold, color: Colors.light.textSecondary },

  // ── Send-to-a-brand flow ──
  back:     { flexDirection: "row", alignItems: "center", gap: 3, alignSelf: "flex-start", marginBottom: 2 },
  backText: { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: "#9C968D" },
  eyebrow: {
    fontFamily: Fonts.bodySemiBold, fontSize: 11, color: "#9C968D",
    letterSpacing: 0.8, textTransform: "uppercase",
  },
  input: {
    fontFamily: Fonts.body,
    fontSize:   14,
    color:      Colors.light.text,
    backgroundColor: Colors.light.backgroundDefault,
    borderRadius: 12,
    borderWidth:  1,
    borderColor:  Colors.light.borderLight,
    paddingHorizontal: 14,
    height: 46,
  },
  help:     { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16, color: "#9C968D", marginTop: -2 },
  sealNote: { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16, color: "#9C968D", textAlign: "center" },

  // ── Sealed success ──
  sealHero: {
    flexDirection: "row", alignItems: "center", gap: 13,
    borderRadius: 18, padding: 14,
    backgroundColor: Bold.ground, borderWidth: 1, borderColor: Bold.line,
  },
  sealHeroText: { flex: 1, fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18, color: Bold.ink2 },

  // Buttons
  primary: {
    height: 52, borderRadius: 999, backgroundColor: Colors.light.primary,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
  },
  primaryDisabled: { opacity: 0.45 },
  primaryDone:     { backgroundColor: "#1A9960" },
  primaryText:     { fontFamily: Fonts.bodySemiBold, fontSize: 16, color: "#FFFFFF" },
  quiet: {
    height: 46, borderRadius: 999, borderWidth: 1, borderColor: Colors.light.border,
    backgroundColor: Colors.light.card,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7,
  },
  quietText: { fontFamily: Fonts.bodySemiBold, fontSize: 13.5, color: Colors.light.text },
});
