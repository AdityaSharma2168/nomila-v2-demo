/**
 * EditSheet — one typed edit, from her tap to her decision (PR 9, Lane 3a): pick the op (or arrive with a
 * recommendation's op and params filled in), give it its few words, see the QUOTE — the price, the sentence
 * the op became, any note — tap to run, see the PREVIEW, then Accept (the one library write; the accepted
 * photo takes the source's place in her picks) or Discard.
 *
 * Ground rule 06 in one screen: nothing spends before the quote's Run tap, nothing enters her library before
 * Accept. ⚠️ MUTATION (editPopoverLogic.test / this file's structure): render Accept before a preview url
 * exists — "accept without preview shown" reds by name (`canAccept`).
 */
import React, { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import { STUDIO_QA_DISPLAY, STUDIO_STYLE_SPEC } from "../../lib/flags";
import { StyleReferenceList } from "./StyleReferenceList";
import type { StyleReferenceRow } from "../../hooks/use-studio-edits";
import {
  useEditAccept,
  useEditDiscard,
  useEditQuote,
  useEditRun,
} from "../../hooks/use-studio-edits";
import {
  canAccept,
  MANUAL_OPS,
  paramsFor,
  quoteBodyFor,
  type LastPicked,
  type SheetStep,
} from "../../screens/studio/editPopoverLogic";
import type {
  EditPresented,
  EditQuote,
  StudioEditOp,
} from "../../screens/studio/editTypes";

export interface EditSheetProps {
  source: LastPicked;
  /** Arriving from a recommendation chip: its op and params, already grounded. */
  initial: { op: StudioEditOp; params: Record<string, unknown> } | null;
  /** Her product photos on this post — a product op places one of them. */
  productIds: string[];
  onClose: () => void;
  /** The accepted asset's id — EXACTLY what the server answered; the caller swaps it into her picks. */
  onAccepted: (acceptedAssetId: string) => void;
}

export function EditSheet({
  source,
  initial,
  productIds,
  onClose,
  onAccepted,
}: EditSheetProps) {
  const [step, setStep] = useState<SheetStep>(initial ? "params" : "op");
  const [op, setOp] = useState<StudioEditOp | null>(initial?.op ?? null);
  const [fields, setFields] = useState<Record<string, string>>(() =>
    flatten(initial?.params ?? {}),
  );
  const [productId, setProductId] = useState<string | null>(
    (typeof initial?.params.productAssetId === "string"
      ? initial.params.productAssetId
      : null) ??
      productIds[0] ??
      null,
  );
  const [quote, setQuote] = useState<{
    edit: EditPresented;
    quote: EditQuote;
  } | null>(null);
  const [edit, setEdit] = useState<EditPresented | null>(null);
  // PR 18: an already-read reference as a style MODIFIER on this op. Null is the sheet exactly as before.
  const [look, setLook] = useState<StyleReferenceRow | null>(null);
  const [lookOpen, setLookOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quoteM = useEditQuote();
  const runM = useEditRun();
  const acceptM = useEditAccept();
  const discardM = useEditDiscard();
  const busy =
    quoteM.isPending ||
    runM.isPending ||
    acceptM.isPending ||
    discardM.isPending;

  const set = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }));
  const params = op ? paramsFor(op, fields, productId) : null;
  const ready = op !== null && params !== null;

  const doQuote = async () => {
    if (!op || !params) return;
    setError(null);
    try {
      const out = await quoteM.mutateAsync(
        quoteBodyFor(
          source.assetId,
          op,
          params,
          STUDIO_STYLE_SPEC ? (look?.assetId ?? null) : null,
        ),
      );
      setQuote(out);
      setStep("quote");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't price that.");
    }
  };
  const doRun = async () => {
    if (!quote) return;
    setError(null);
    try {
      const out = await runM.mutateAsync({ id: quote.edit.id });
      setEdit(out.edit);
      setStep("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't make that.");
    }
  };
  const doAccept = async () => {
    if (!canAccept(step, edit) || !edit) return;
    setError(null);
    try {
      const out = await acceptM.mutateAsync({ id: edit.id });
      onAccepted(out.assetId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't keep that.");
    }
  };
  const doDiscard = async () => {
    const id = edit?.id ?? quote?.edit.id;
    if (id) await discardM.mutateAsync({ id }).catch(() => undefined);
    onClose();
  };

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet} testID="edit-sheet">
        <View style={styles.head}>
          <Text style={styles.title}>
            {source.list === "products" ? "PRODUCT" : "PHOTO"} {source.ordinal}{" "}
            · {STEP_TITLE[step]}
          </Text>
          <Pressable
            onPress={
              step === "preview" || step === "quote" ? doDiscard : onClose
            }
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Feather name="x" size={18} color={Colors.light.textMuted} />
          </Pressable>
        </View>
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          {step === "op" ? (
            <View style={styles.list}>
              {MANUAL_OPS.map((m) => (
                <Pressable
                  key={m.op}
                  style={styles.opRow}
                  onPress={() => {
                    setOp(m.op);
                    setStep("params");
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={m.label}
                  testID={`edit-op-${m.op}`}
                >
                  <View style={styles.opMain}>
                    <Text style={styles.opLabel}>{m.label}</Text>
                    <Text style={styles.hint}>{m.hint}</Text>
                  </View>
                  <Feather
                    name="chevron-right"
                    size={16}
                    color={Colors.light.textMuted}
                  />
                </Pressable>
              ))}
            </View>
          ) : null}

          {step === "params" && op ? (
            <View style={styles.list}>
              <ParamsForm
                op={op}
                fields={fields}
                set={set}
                productIds={productIds}
                productId={productId}
                setProductId={setProductId}
              />
              {/* PR 18, EXPO_PUBLIC_STUDIO_STYLE_SPEC: a look from a reference she has already had read, on
                  top of this change. Off: nothing renders and the body is exactly as before. */}
              {STUDIO_STYLE_SPEC ? (
                <View style={styles.field} testID="edit-look">
                  <Text style={styles.label}>MATCH A LOOK · OPTIONAL</Text>
                  {look && !lookOpen ? (
                    <View style={styles.opRow}>
                      <Text
                        style={[styles.hint, styles.opMain]}
                        numberOfLines={2}
                      >
                        {look.caption}
                      </Text>
                      <Pressable
                        onPress={() => setLook(null)}
                        accessibilityRole="button"
                        accessibilityLabel="Remove the look"
                        hitSlop={8}
                      >
                        <Feather
                          name="x"
                          size={16}
                          color={Colors.light.textMuted}
                        />
                      </Pressable>
                    </View>
                  ) : lookOpen ? (
                    <StyleReferenceList
                      selectedAssetId={look?.assetId ?? null}
                      onPick={(r) => {
                        setLook(r);
                        setLookOpen(false);
                      }}
                    />
                  ) : (
                    <Pressable
                      style={styles.opRow}
                      onPress={() => setLookOpen(true)}
                      accessibilityRole="button"
                      accessibilityLabel="Match a look you've had read"
                    >
                      <Feather
                        name="aperture"
                        size={16}
                        color={Colors.light.primary}
                      />
                      <Text style={[styles.opLabel, styles.opMain]}>
                        Match a look you&apos;ve had read
                      </Text>
                    </Pressable>
                  )}
                </View>
              ) : null}
              <Pressable
                style={[styles.cta, (!ready || busy) && styles.ctaOff]}
                disabled={!ready || busy}
                onPress={doQuote}
                accessibilityRole="button"
                accessibilityLabel="See the price"
                testID="edit-quote"
              >
                {quoteM.isPending ? (
                  <ActivityIndicator color={Colors.light.buttonText} />
                ) : (
                  <Text style={styles.ctaTxt}>See the price</Text>
                )}
              </Pressable>
            </View>
          ) : null}

          {step === "quote" && quote ? (
            <View style={styles.list}>
              <Text style={styles.sentence}>“{quote.quote.sentence}”</Text>
              <Text style={styles.price}>
                {quote.quote.unpriced || quote.quote.costUsd === null
                  ? "Price unknown — this can't run."
                  : `$${quote.quote.costUsd.toFixed(2)} · one edit of this photo`}
              </Text>
              {quote.quote.warnings.map((w, i) => (
                <Text key={i} style={styles.hint}>
                  {w}
                </Text>
              ))}
              <Pressable
                style={[
                  styles.cta,
                  (busy || quote.quote.unpriced) && styles.ctaOff,
                ]}
                disabled={busy || quote.quote.unpriced}
                onPress={doRun}
                accessibilityRole="button"
                accessibilityLabel={`Make it for $${(quote.quote.costUsd ?? 0).toFixed(2)}`}
                testID="edit-run"
              >
                {runM.isPending ? (
                  <ActivityIndicator color={Colors.light.buttonText} />
                ) : (
                  <Text style={styles.ctaTxt}>
                    Make it · ${(quote.quote.costUsd ?? 0).toFixed(2)}
                  </Text>
                )}
              </Pressable>
              <Text style={styles.hint}>
                Nothing is charged until you tap. Making it takes about half a
                minute.
              </Text>
            </View>
          ) : null}

          {step === "preview" && edit ? (
            <View style={styles.list}>
              {edit.url ? (
                <Image
                  source={{ uri: edit.url }}
                  style={styles.preview}
                  resizeMode="contain"
                  accessibilityLabel="The edited photo"
                />
              ) : null}
              {/* What this edit cost, off the edit row (`presentEdit` already returns it), behind
                  EXPO_PUBLIC_STUDIO_QA_DISPLAY (PR 11). An edit has no verdict — edits are not
                  inspected — so this is the cost alone. Off: the step exactly as before. */}
              {STUDIO_QA_DISPLAY && edit.costUsd !== null ? (
                <Text style={styles.hint} testID="edit-cost">
                  This edit cost ${edit.costUsd.toFixed(2)}.
                </Text>
              ) : null}
              <Text style={styles.hint}>
                Keep it and it takes this photo's place in your picks — a new
                photo in your library, made from this one. Discard and nothing
                is kept.
              </Text>
              {canAccept(step, edit) ? (
                <Pressable
                  style={[styles.cta, busy && styles.ctaOff]}
                  disabled={busy}
                  onPress={doAccept}
                  accessibilityRole="button"
                  accessibilityLabel="Keep it"
                  testID="edit-accept"
                >
                  {acceptM.isPending ? (
                    <ActivityIndicator color={Colors.light.buttonText} />
                  ) : (
                    <Text style={styles.ctaTxt}>Keep it</Text>
                  )}
                </Pressable>
              ) : null}
              <Pressable
                style={styles.secondary}
                disabled={busy}
                onPress={doDiscard}
                accessibilityRole="button"
                accessibilityLabel="Discard"
                testID="edit-discard"
              >
                <Text style={styles.secondaryTxt}>Discard</Text>
              </Pressable>
            </View>
          ) : null}

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
      </View>
    </Modal>
  );
}

const STEP_TITLE: Record<SheetStep, string> = {
  op: "WHAT TO CHANGE",
  params: "SAY HOW",
  quote: "THE PRICE",
  preview: "THE RESULT",
};

function flatten(p: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) if (typeof v === "string") out[k] = v;
  const place = p.place as { preposition?: string; place?: string } | undefined;
  if (place?.preposition) out.preposition = place.preposition;
  if (place?.place) out.place = place.place;
  return out;
}

function ParamsForm({
  op,
  fields,
  set,
  productIds,
  productId,
  setProductId,
}: {
  op: StudioEditOp;
  fields: Record<string, string>;
  set: (k: string, v: string) => void;
  productIds: string[];
  productId: string | null;
  setProductId: (id: string) => void;
}) {
  const field = (k: string, label: string, placeholder: string, max = 40) => (
    <View style={styles.field} key={k}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={fields[k] ?? ""}
        onChangeText={(v) => set(k, v.slice(0, max))}
        placeholder={placeholder}
        placeholderTextColor={Colors.light.textMuted}
        accessibilityLabel={label}
        autoCapitalize="none"
      />
    </View>
  );
  switch (op) {
    case "recolour":
      return (
        <>
          {field("target", "THE THING", "jersey, shorts, boots")}
          {field("colour", "THE COLOUR", "red, navy blue", 30)}
        </>
      );
    case "garment":
      return (
        <>
          {field("garment", "THE GARMENT", "jersey, socks")}
          {field("brand", "SWAP IT TO THIS BRAND'S", "adidas")}
          <Text style={styles.hint}>or</Text>
          {field("design", "PUT THIS ON IT", "a stripe, a lightning bolt", 60)}
        </>
      );
    case "product": {
      const mode = fields.mode || "place";
      const modes: [string, string][] = [
        ["place", "My product photo"],
        ["add", "Draw a thing in"],
        ["remove", "Take a thing out"],
      ];
      return (
        <>
          <View style={styles.field}>
            <Text style={styles.label}>WHICH</Text>
            <View style={styles.chips}>
              {modes.map(([m, label]) => (
                <Pressable
                  key={m}
                  style={[styles.chip, mode === m && styles.chipOn]}
                  onPress={() => set("mode", m)}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: mode === m }}
                  testID={`edit-sheet-product-${m}`}
                >
                  <Text
                    style={[styles.chipTxt, mode === m && styles.chipTxtOn]}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          {mode === "remove" ? (
            field("target", "WHAT TO TAKE OUT", "water bottle, cone, bag")
          ) : (
            <>
              {mode === "place" ? (
                productIds.length ? (
                  <View style={styles.field}>
                    <Text style={styles.label}>WHICH PRODUCT PHOTO</Text>
                    <View style={styles.chips}>
                      {productIds.map((id, i) => (
                        <Pressable
                          key={id}
                          style={[
                            styles.chip,
                            productId === id && styles.chipOn,
                          ]}
                          onPress={() => setProductId(id)}
                          accessibilityRole="button"
                          accessibilityLabel={`Product ${i + 1}`}
                          accessibilityState={{ selected: productId === id }}
                        >
                          <Text
                            style={[
                              styles.chipTxt,
                              productId === id && styles.chipTxtOn,
                            ]}
                          >
                            Product {i + 1}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                ) : (
                  <Text style={styles.hint}>
                    Pick a product photo under YOUR PRODUCTS first — that is
                    what gets placed.
                  </Text>
                )
              ) : (
                <Text style={styles.hint}>
                  No photo — the model draws it, so it will be a generic one.
                </Text>
              )}
              {field(
                "thing",
                mode === "add" ? "WHAT TO DRAW IN" : "WHAT IT IS",
                "soccer ball, water bottle",
              )}
              {field("preposition", "WHERE (HOW)", "on the ground next to", 24)}
              {field("place", "WHERE (WHAT)", "me, the bench")}
            </>
          )}
        </>
      );
    }
    case "background_clean":
      return (
        <>
          {field(
            "setting",
            "WHAT SHOULD BE BEHIND YOU (optional)",
            "same place with nobody else and no signs",
            40,
          )}
        </>
      );
    case "ad":
      return null;
  }
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.border,
  },
  title: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: Colors.light.textMuted,
  },
  body: { padding: Spacing.lg, gap: Spacing.md },
  list: { gap: Spacing.md },
  opRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.card,
  },
  opMain: { flex: 1, gap: 3 },
  opLabel: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
    fontWeight: "600",
    color: Colors.light.text,
  },
  hint: {
    fontFamily: Fonts.body,
    fontSize: 11.5,
    lineHeight: 16,
    color: Colors.light.textMuted,
  },
  field: { gap: 6 },
  label: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: Colors.light.textMuted,
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
  sentence: {
    fontFamily: Fonts.body,
    fontSize: 15,
    lineHeight: 21,
    color: Colors.light.text,
    fontStyle: "italic",
  },
  price: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
    fontWeight: "600",
    color: Colors.light.text,
  },
  cta: {
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
    color: Colors.light.textMuted,
  },
  preview: {
    width: "100%",
    aspectRatio: 3 / 4,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.card,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 7,
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
    fontSize: 12,
    fontWeight: "600",
    color: Colors.light.text,
  },
  chipTxtOn: { color: Colors.light.buttonText },
  refusal: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  refusalTxt: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: Colors.light.text,
  },
});
