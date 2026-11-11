// RatesDoor — Me's door to "Your rates" (deals design §5c; D9). Drawn only with EXPO_PUBLIC_OPPS_V2: one white card,
// one row (a black dollar tile, the title, what it holds), the whole card the target (DESIGN.md §11 Card).
import React from "react";
import { type StyleProp, type ViewStyle } from "react-native";
import { Card, IconTile, Row } from "../ui";
import { OPPS_V2 } from "../../lib/flags";

export const RATES_DOOR_COPY = { title: "Your rates", meta: "Mila suggests. You set your minimum." } as const;

export function RatesDoor({ onPress, style, enabled = OPPS_V2 }: { onPress: () => void; style?: StyleProp<ViewStyle>; enabled?: boolean }) {
  if (!enabled) return null;
  return (
    <Card bold style={style} testID="me-rates-door">
      <Row bold leading={<IconTile icon="dollar-sign" bold="black" />} value={RATES_DOOR_COPY.title} meta={RATES_DOOR_COPY.meta} onPress={onPress} last
        accessibilityLabel={`${RATES_DOOR_COPY.title}. ${RATES_DOOR_COPY.meta}`} />
    </Card>
  );
}
