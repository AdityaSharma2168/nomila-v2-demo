/**
 * SetupScreen — what goes in, before anything is planned.
 *
 * ─── ROWS, ONE OPEN AT A TIME ──────────────────────────────────────────────────────────────────
 * Product and Extra instructions. Each collapses to a single line showing what is in it, so the
 * whole screen is legible at a glance and only the row she is working on takes any height.
 * Opening one closes the others: two open rows and the screen is a form again.
 *
 * ─── THE LABELS ARE NOT UPPERCASE ──────────────────────────────────────────────────────────────
 * "Extra instructions" will not fit a tracked uppercase column at any readable size, and wrapping
 * a label to two lines is what made the row look like a form field rather than a summary. Sentence
 * case in a wider column keeps all three on one line.
 *
 * ─── WHY "EXTRA INSTRUCTIONS" AND NOT "NOTES" ──────────────────────────────────────────────────
 * Notes are conventionally for yourself. This text is instructions to the thing that makes the
 * work, and it is passed through to the model verbatim — so the label says so, and the expanded
 * row shows exactly where her words land rather than claiming it.
 */
import React, { useState } from "react";
import {
  View, Text, ScrollView, SafeAreaView, StatusBar, StyleSheet, TextInput, Image, Modal,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { StudioStackParamList } from "../../navigation/MainTabNavigator";
import { HapticPressable } from "../../components/HapticPressable";
import { MediaLibraryView } from "../../components/media/MediaLibraryView";
import { Colors, Fonts, Spacing } from "../../constants/theme";
import { STUDIO_IMAGE_EDIT } from "../../lib/flags";
import { sourceFrameFor, trayLabelFor } from "../../lib/studio-contract";
import type { Attachment, StudioFormat } from "../../lib/studio-contract";
import type { PickableRole } from "./AttachSheet";

// inspiration role retired from picker (D1); still dropped server-side — see toEngineReferences.
// Re-add here if a typed style slot lands.
type Row = "product" | "instructions" | null;

const FORMATS: { key: StudioFormat; label: string }[] = [
  { key: "photo",    label: "Photo" },
  { key: "carousel", label: "Carousel" },
  { key: "video",    label: "Video" },
  { key: "story",    label: "Story" },
];

export function SetupScreen({
  title, subtitle, brandName, brandId, concept, onBack, initialFormat = "photo",
}: {
  title: string;
  subtitle: string;
  /** Null for a personal post — there is no product row when nothing is owed to anyone. */
  brandName: string | null;
  /**
   * The brand this is FOR, as the server knows it. Separate from `brandName` because the name is
   * copy and this is a key: it tailors the brief to the partner and decides the objective, and a
   * deal whose brand the resolver never matched has a name and no id.
   */
  brandId: number | null;
  concept: { title: string; line: string };
  onBack: () => void;
  /** The format she already chose on the brand post's plan step (PR 6, 6d); "photo" otherwise, as before. */
  initialFormat?: StudioFormat;
}) {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  const [open, setOpen] = useState<Row>(null);
  const [format, setFormat] = useState<StudioFormat>(initialFormat);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [instructions, setInstructions] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [picking, setPicking] = useState<PickableRole | null>(null);

  const of = (role: PickableRole) => attachments.filter((a) => a.role === role);
  const products = of("product");
  const frames = of("source-frame");

  const add = (role: PickableRole, a: Attachment) => setAttachments((xs) => [...xs, a]);
  const drop = (id: string) => setAttachments((xs) => xs.filter((x) => x.id !== id));

  // THE CAROUSEL IS THE AD FLOW (PR 9): one photo of hers → three ads for the brand on the brief, on its own
  // screen, saved frame by frame. It never goes through Make it. The first photo she attached here rides along.
  // With STUDIO_IMAGE_EDIT off the ad flow's routes are 404 (PR 10, R-1): the chip is what it was before
  // PR 9 — Make it, through toPlan — and nothing on the Carousel Create screen is ever asked.
  // ⚠️ MUTATION (CarouselCreateScreen.test / carouselLogic.test): drop the guard — "Create screen fires a
  // request with the flag off" reds by name.
  const adFlow = format === "carousel" && STUDIO_IMAGE_EDIT;
  const toCarousel = () => {
    if (!STUDIO_IMAGE_EDIT) {
      toPlan();
      return;
    }
    nav.navigate("StudioCarouselCreate", {
      brand: brandName ?? title,
      campaign: { story: concept.line },
      briefLines: [concept.title, concept.line].filter(Boolean),
      ...(sourceFrameFor(attachments)?.assetId
        ? { refs: [sourceFrameFor(attachments)!.assetId as string] }
        : {}),
    });
  };
  const toPlan = () =>
    nav.navigate("StudioMakeIt", {
      title: concept.title,
      line: concept.line,
      format,
      attachments,
      brandName,
      brandId,
      // Her words, verbatim, exactly as the expanded row promises. Empty stays undefined rather
      // than an empty string, so the brief carries no direction at all rather than a blank one.
      direction: instructions.trim() || undefined,
      // Her first photograph, NAMED as the frame. Make it no longer picks one when none is passed
      // (frame defaulting, 2026-09-16) — and this screen has no badge to mark with, so it says what
      // it always meant: the first photo of hers routes exactly as it did before.
      frameAssetId: sourceFrameFor(attachments)?.assetId ?? null,
    });

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.topbar}>
        <HapticPressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="chevron-left" size={22} color={Colors.light.text} />
        </HapticPressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.topTitle}>{title}</Text>
          <Text style={styles.topSub}>{subtitle}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.conceptCard}>
          <Text style={styles.conceptTitle}>{concept.title}</Text>
          <Text style={styles.conceptLine}>{concept.line}</Text>
          <View style={styles.formats}>
            {FORMATS.map((f) => (
              <HapticPressable
                key={f.key}
                style={[styles.fmt, format === f.key && styles.fmtOn]}
                onPress={() => setFormat(f.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: format === f.key }}
                accessibilityLabel={f.label}
              >
                <Text style={[styles.fmtTxt, format === f.key && styles.fmtTxtOn]}>{f.label}</Text>
              </HapticPressable>
            ))}
          </View>
        </View>

        <SummaryRow
          label="Your media"
          value={frames.length ? `${frames.length} picked` : null}
          open={open === null && false}
          onPress={() => setPicking("source-frame")}
          chevron="plus"
        />

        {brandName ? (
          <SummaryRow
            label="Product"
            value={products.length ? products.map((p) => p.name).join(", ") : null}
            open={open === "product"}
            onPress={() => setOpen(open === "product" ? null : "product")}
          >
            <Text style={styles.rowNote}>
              A brand rejects a wrong product faster than anything else, so this has to be the
              actual piece — never one described.
            </Text>
            <Thumbs items={products} onDrop={drop} />
            <HapticPressable style={styles.action} onPress={() => setPicking("product")} accessibilityRole="button">
              <Feather name="image" size={15} color={Colors.light.primary} />
              <Text style={styles.actionTxt}>Find the product</Text>
            </HapticPressable>
          </SummaryRow>
        ) : null}

        <SummaryRow
          label="Extra instructions"
          value={instructions.trim() ? instructions.trim() : null}
          open={open === "instructions"}
          onPress={() => setOpen(open === "instructions" ? null : "instructions")}
        >
          <View style={styles.textBox}>
            <TextInput
              style={styles.textInput}
              value={instructions}
              onChangeText={setInstructions}
              placeholder="Type anything — tone, a thing to avoid, somewhere it has to work."
              placeholderTextColor={Colors.light.tabIconDefault}
              multiline
            />
          </View>

          <HapticPressable
            style={styles.disclose}
            onPress={() => setShowPrompt((p) => !p)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showPrompt }}
            accessibilityLabel="See where your words land"
          >
            <Feather name={showPrompt ? "chevron-up" : "chevron-down"} size={14} color={Colors.light.textMuted} />
            <Text style={styles.discloseTxt}>See where your words land</Text>
          </HapticPressable>

          {showPrompt ? (
            <View style={styles.promptBox}>
              <Text style={styles.promptTxt}>
                <Text style={styles.promptDim}>{concept.title}</Text>
                {instructions.trim() ? (
                  <Text style={styles.promptMine}>{` — ${instructions.trim()}`}</Text>
                ) : null}
                <Text style={styles.promptDim}>
                  {" — subject reference: your frames; identity preserved; no third-party marks."}
                </Text>
              </Text>
              <Text style={styles.promptNote}>
                {instructions.trim()
                  ? "The highlighted part is yours, passed through word for word."
                  : "Nothing of yours in it yet. Whatever you type goes in here word for word."}
              </Text>
            </View>
          ) : null}
        </SummaryRow>
      </ScrollView>

      <View style={styles.footer}>
        <HapticPressable
          haptic="press"
          style={styles.cta}
          onPress={format === "carousel" ? toCarousel : toPlan}
          accessibilityRole="button"
          accessibilityLabel={adFlow ? "Make the ads" : "Build the plan"}
        >
          <Text style={styles.ctaTxt}>{adFlow ? "Make the ads" : "Build the plan"}</Text>
        </HapticPressable>
        <Text style={styles.footNote}>
          {adFlow
            ? "Still free — next you pick the photo and see the price for three ads."
            : "Still free — next you see the frames and what each costs."}
        </Text>
      </View>

      <Modal visible={picking !== null} animationType="slide" onRequestClose={() => setPicking(null)}>
        <SafeAreaView style={styles.safe}>
          <View style={styles.topbar}>
            <HapticPressable onPress={() => setPicking(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
              <Feather name="chevron-left" size={22} color={Colors.light.text} />
            </HapticPressable>
            <Text style={styles.topTitle}>{PICKER_TITLE[picking ?? "source-frame"]}</Text>
          </View>
          <MediaLibraryView
            onPick={(m) => {
              const role = picking;
              if (!role) return;
              setPicking(null);
              add(role, {
                id: `${role}:${m.asset_id}`,
                role,
                name: trayLabelFor(m.shot_type, role),
                uri: m.thumb_url ?? m.url,
                assetId: m.asset_id,
                // This screen used to discard `m.media_type` on this very line, and it has no
                // media-type map of its own — so a clip tagged "You" here reached Make it as an
                // ordinary photograph of hers and was sent as a likeness into an edit (F-AM7).
                // Carrying it on the attachment protects this screen without it having to know.
                mediaType: m.media_type,
              });
            }}
          />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

/**
 * The picker heading for every role she can actually attach.
 *
 * Excluding `inspiration` rather than carrying a dead entry is deliberate: a future inspiration
 * picker then fails to COMPILE instead of opening under a blank title. Safe because attachments
 * aren't persisted (local state + route params only; useStudioThreads is a stub). If threads ever
 * persist, inspiration becomes a legacy-draft case and these maps need a fallback, not Exclude.
 */
const PICKER_TITLE: Record<PickableRole, string> = {
  "source-frame": "Pick from your library",
  product: "Which product is it?",
  object: "What should go in the shot?",
  // PR 18. The label a Style picker would carry; this screen's own rows offer no Style tile.
  style: "Pick a look you've had read",
};

/**
 * One row. Collapsed it shows the label and what is in it; opened it shows the controls. The value
 * line is what makes the collapsed screen readable — a row that says nothing when closed forces
 * her to open all three to find out where she is.
 */
function SummaryRow({
  label, value, open, onPress, children, chevron,
}: {
  label: string;
  value: string | null;
  open: boolean;
  onPress: () => void;
  children?: React.ReactNode;
  chevron?: "plus";
}) {
  return (
    <View style={[styles.row, open && styles.rowOpen]}>
      <HapticPressable
        style={styles.rowHead}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${label}. ${value ?? "nothing yet"}`}
      >
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={[styles.rowValue, !value && styles.rowValueEmpty]} numberOfLines={1}>
          {value ?? "—"}
        </Text>
        <Feather
          name={chevron === "plus" ? "plus" : open ? "chevron-down" : "chevron-right"}
          size={16}
          color={Colors.light.tabIconDefault}
        />
      </HapticPressable>
      {open ? <View style={styles.rowBody}>{children}</View> : null}
    </View>
  );
}

function Thumbs({ items, onDrop }: { items: Attachment[]; onDrop: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
      {items.map((a) => (
        <View key={a.id} style={styles.thumbWrap}>
          <View style={styles.thumb}>
            {a.uri ? (
              <Image source={{ uri: a.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            ) : (
              <View style={[StyleSheet.absoluteFill, styles.thumbBlank]}>
                <Feather name="link" size={14} color={Colors.light.primary} />
              </View>
            )}
          </View>
          <HapticPressable
            style={styles.thumbX}
            onPress={() => onDrop(a.id)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${a.name}`}
          >
            <Feather name="x" size={10} color={Colors.light.buttonText} />
          </HapticPressable>
        </View>
      ))}
    </ScrollView>
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

  body: { padding: Spacing.xl, paddingBottom: 24 },

  conceptCard: {
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 16, padding: 14, marginBottom: 14,
  },
  conceptTitle: {
    fontFamily: Fonts.display, fontSize: 18, fontWeight: "800",
    letterSpacing: -0.4, color: Colors.light.text,
  },
  conceptLine: {
    fontFamily: Fonts.body, fontSize: 13, lineHeight: 19,
    color: Colors.light.textSecondary, marginTop: 5,
  },
  formats: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 12 },
  fmt: {
    borderRadius: 99, paddingHorizontal: 13, paddingVertical: 7,
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.backgroundDefault,
  },
  fmtOn: { borderColor: Colors.light.primary, backgroundColor: Colors.light.primary },
  fmtTxt: { fontFamily: Fonts.bodyBold, fontSize: 12.5, fontWeight: "700", color: Colors.light.text },
  fmtTxtOn: { color: Colors.light.buttonText },

  row: {
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 14, marginBottom: 7, overflow: "hidden",
  },
  rowOpen: { borderColor: Colors.light.primary },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
  rowLabel: {
    width: 104, fontFamily: Fonts.bodySemiBold, fontSize: 11.5, fontWeight: "600",
    color: Colors.light.textMuted,
  },
  rowValue: { flex: 1, fontFamily: Fonts.body, fontSize: 12.5, color: Colors.light.text },
  rowValueEmpty: { color: Colors.light.tabIconDefault },
  rowBody: { paddingHorizontal: 12, paddingBottom: 12, gap: 9 },
  rowNote: { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16, color: Colors.light.textMuted },

  action: {
    flexDirection: "row", alignItems: "center", gap: 9,
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.backgroundDefault,
    borderRadius: 12, padding: 11,
  },
  actionTxt: { fontFamily: Fonts.bodyBold, fontSize: 12.5, fontWeight: "700", color: Colors.light.text },

  thumbs: { gap: 7, paddingVertical: 2, paddingRight: 4 },
  thumbWrap: { width: 46 },
  thumb: {
    width: 46, height: 46, borderRadius: 9, overflow: "hidden",
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.primaryLight,
  },
  thumbBlank: { alignItems: "center", justifyContent: "center" },
  thumbX: {
    position: "absolute", right: -4, top: -4, width: 17, height: 17, borderRadius: 99,
    backgroundColor: Colors.light.text, alignItems: "center", justifyContent: "center",
  },

  textBox: {
    backgroundColor: Colors.light.backgroundDefault, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 12, padding: 11,
  },
  textInput: {
    fontFamily: Fonts.body, fontSize: 13.5, lineHeight: 19,
    color: Colors.light.text, minHeight: 66, padding: 0, textAlignVertical: "top",
  },
  disclose: { flexDirection: "row", alignItems: "center", gap: 8 },
  discloseTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 11.5, fontWeight: "600", color: Colors.light.textMuted },
  promptBox: { backgroundColor: Colors.light.text, borderRadius: 12, padding: 11 },
  promptTxt: { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 17.5 },
  promptDim: { color: Colors.light.tabIconDefault },
  promptMine: { color: Colors.light.primaryLight, fontFamily: Fonts.bodyBold, fontWeight: "700" },
  promptNote: {
    fontFamily: Fonts.body, fontSize: 10.5, lineHeight: 15,
    color: Colors.light.tabIconDefault, marginTop: 8,
  },

  footer: {
    borderTopWidth: 1, borderTopColor: Colors.light.border, backgroundColor: Colors.light.card,
    paddingHorizontal: Spacing.xl, paddingTop: 11, paddingBottom: 16,
  },
  cta: { backgroundColor: Colors.light.primary, borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  ctaTxt: { fontFamily: Fonts.bodyBold, fontSize: 15, fontWeight: "700", color: Colors.light.buttonText },
  footNote: {
    fontFamily: Fonts.body, fontSize: 10.5, lineHeight: 15,
    color: Colors.light.textMuted, textAlign: "center", marginTop: 7,
  },
});
