// Brand › Rates — the least you'll take, per deal type (her floor; moved here from Settings).
//
// Legacy retirement, phase 1 (owner decision 8 Oct 2026): the computed rate card (per-platform post
// rates, projected annual value, "Verified" chips) is gone from this screen until a new rate model
// exists. Nothing stands in for it; her own floor — her words — stays exactly as it was.

import React from "react";
import { StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors, Spacing } from "../../constants/theme";
import { RatesFloorSection } from "../../components/settings/RatesFloorSection";
import { BrandStackShell } from "./BrandStackShell";
import { Card } from "../../components/ui";

const C = Colors.light;

export function RatesScreen() {
  return (
    <BrandStackShell title="Your floor">
      <Card style={styles.floor}>
        <Card.Header
          icon={<Feather name="dollar-sign" size={16} color={C.primary} />}
          iconTint={C.primaryLight}
          title="Your floor"
          subtitle="The least you'll take, per deal type. Mila flags offers under it."
        />
        <Card.Body>
          <RatesFloorSection />
        </Card.Body>
      </Card>
    </BrandStackShell>
  );
}

const styles = StyleSheet.create({
  floor: { marginHorizontal: Spacing.xl, marginTop: Spacing.md },
});
