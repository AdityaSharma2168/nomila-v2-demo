// SeriousOfferSettings — her Serious offer switch and amount ($50 / $100 / $150 / $250; on by default, $50), on Me ›
// "Your public card" (the section that track mounts). Self-contained: reads and writes /api/v1/me/partner/settings.
// Kept apart from the board section so the board never loads the API client. Look B (DESIGN.md).
import React from "react";
import { View, Text, Pressable, Switch, StyleSheet } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "../ui/Card";
import { Bold, BoldType } from "../../constants/theme";
import { apiRequest } from "../../lib/query-client";
import { PARTNER_INTAKE } from "../../lib/flags";
import { SERIOUS_OFFER_COPY } from "./SeriousOffers";

export const SETTINGS_KEY = "/api/v1/me/partner/settings";

const usd = (cents: number) => `$${Math.round(cents / 100)}`;

interface Settings { serious_offer_enabled: boolean; serious_offer_cents: number; amounts: number[] }

export function SeriousOfferSettings({ enabled = PARTNER_INTAKE }: { enabled?: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<Settings>({ queryKey: [SETTINGS_KEY], enabled });
  const save = useMutation({
    mutationFn: async (patch: Partial<Pick<Settings, "serious_offer_enabled" | "serious_offer_cents">>) =>
      (await apiRequest("PUT", SETTINGS_KEY, patch)).json() as Promise<Settings>,
    onSuccess: (next) => qc.setQueryData([SETTINGS_KEY], next),
  });
  if (!enabled) return null;
  if (isLoading || error || !data) {
    return (
      <Card bold style={styles.settings} testID="serious-offer-settings">
        <Text style={styles.rowM}>{isLoading ? "Loading…" : "Couldn’t load your Serious offer setting."}</Text>
      </Card>
    );
  }
  const on = data.serious_offer_enabled;
  return (
    <Card bold style={styles.settings} testID="serious-offer-settings">
      <View style={styles.switchRow}>
        <View style={styles.rowTxt}>
          <Text style={styles.rowT}>{SERIOUS_OFFER_COPY.settingsTitle}</Text>
          <Text style={styles.rowM}>{SERIOUS_OFFER_COPY.settingsSub}</Text>
        </View>
        <Switch value={on} onValueChange={(v) => save.mutate({ serious_offer_enabled: v })} disabled={save.isPending}
                trackColor={{ true: Bold.blue, false: Bold.track }} accessibilityLabel={SERIOUS_OFFER_COPY.settingsTitle} testID="serious-offer-switch" />
      </View>
      {on ? (
        <>
          <Text style={styles.label}>{SERIOUS_OFFER_COPY.amount}</Text>
          <View style={styles.amounts} accessibilityRole="radiogroup">
            {data.amounts.map((a) => {
              const selected = a === data.serious_offer_cents;
              return (
                <Pressable key={a} onPress={() => save.mutate({ serious_offer_cents: a })} disabled={save.isPending || selected}
                           style={[styles.amount, selected && styles.amountOn]} accessibilityRole="radio" accessibilityState={{ selected }} testID={`serious-offer-amount-${a}`}>
                  <Text style={[styles.amountT, selected && styles.amountTOn]}>{usd(a)}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}
      <Text style={styles.explain}>{SERIOUS_OFFER_COPY.explain}</Text>
      <Text style={styles.explain}>{SERIOUS_OFFER_COPY.others}</Text>
      {save.isError ? <Text style={styles.rowBlue}>Couldn’t save. Try again.</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  settings:  { paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowTxt:    { flex: 1, gap: 2 },
  rowT:      { ...BoldType.rowTitle, color: Bold.ink, flexShrink: 1 },
  rowM:      { ...BoldType.rowMeta, color: Bold.mute },
  rowBlue:   { ...BoldType.rowMeta, color: Bold.blue },
  label:     { ...BoldType.label, color: Bold.mute },
  amounts:   { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  amount:    { minWidth: 64, height: Bold.buttonSmall, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: Bold.ink, borderRadius: Bold.radius.control, paddingHorizontal: 12 },
  amountOn:  { backgroundColor: Bold.ink },
  amountT:   { ...BoldType.buttonSmall, color: Bold.ink },
  amountTOn: { color: Bold.onDark },
  explain:   { ...BoldType.caption, color: Bold.mute },
});
