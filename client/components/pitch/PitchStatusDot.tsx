import React from "react";
import { View } from "react-native";
import { Bold } from "../../constants/theme";
import { PITCH_STATUS } from "./pitchStatus";
import type { PitchStatus } from "../../hooks/use-pitches";

/**
 * The status dot — the atom every pitch surface shares. Opened glows gold; a stale pitch
 * carries a gold ring over its base color; otherwise it wears `borderColor` (the surrounding
 * bg) so it reads cleanly when overlaid on an avatar.
 */
export function PitchStatusDot({
  status,
  stale = false,
  size = 10,
  borderColor,
}: {
  status: PitchStatus;
  stale?: boolean;
  size?: number;
  borderColor?: string;
}) {
  const color = PITCH_STATUS[status].color;
  return (
    <View
      style={[
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        borderColor ? { borderWidth: Math.max(1.5, size * 0.16), borderColor } : null,
        stale ? { borderWidth: Math.max(1.5, size * 0.16), borderColor: Bold.ink } : null,
        status === "opened"
          ? {
              shadowColor: Bold.ink,
              shadowOpacity: 0.3,
              shadowRadius: size * 0.4,
              shadowOffset: { width: 0, height: 0 },
              elevation: 3,
            }
          : null,
      ]}
    />
  );
}
