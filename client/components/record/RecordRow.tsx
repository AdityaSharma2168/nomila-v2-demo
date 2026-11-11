// One fact in the athlete record: label, value, and who it came from. On the kit: a Row with a
// KindChip trailing. A row with a `link` (score, deals, connections) shows ↗ — those facts are
// owned by other screens.

import React from "react";
import type { RecordEntry, RecordKind } from "../../hooks/use-athlete-record";
import { kindLabel, sourceLine } from "../../lib/recordLogic";
import { Row, Chip } from "../ui";

export function KindChip({ kind }: { kind: RecordKind | null }) {
  return <Chip tint={kind ?? "none"}>{kindLabel(kind)}</Chip>;
}

export function RecordRow({ entry, onPress, last }: { entry: RecordEntry; onPress: (e: RecordEntry) => void; last?: boolean }) {
  const empty = entry.value === null || entry.value === "";
  return (
    <Row
      label={entry.label}
      value={entry.value}
      empty={entry.editable ? "Add it" : "Not yet"}
      meta={empty ? undefined : sourceLine(entry)}
      trailing={<KindChip kind={entry.kind} />}
      external={!!entry.link}
      onPress={() => onPress(entry)}
      last={last}
      accessibilityLabel={`${entry.label}: ${entry.value ?? "not yet"}`}
    />
  );
}
