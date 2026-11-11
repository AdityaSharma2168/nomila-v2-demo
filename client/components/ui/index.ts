// The UI kit — six parts taken from the deal card and the deck, built from the theme tokens.
// A new screen is built from these; an old screen migrates one PR at a time. The rule for a
// migrated screen: you cannot tell it moved. Kit page (measurements, before/after):
// https://claude.ai/code/artifact/814fcfe0-1537-4764-be21-51050dbe3ef0
//
// Look B (DESIGN.md "B · Full-bleed bold", Oct 2026): every part takes a `bold` prop — Card (white, 1px line, corner 6),
// Row, Chip ("light" | "dark" | "blue" | "line"), Button ("primary" | "secondary" | "small" | "onHero" | "link"), IconTile
// ("black" | "grey"), LogoMark, StackHeader — and ui/Bold holds the shared pieces (SectionHead, Eyebrow, LinkText,
// HerWords, RuledHead). The Concept 0.4 surfaces pass `bold`; a legacy screen that does not keeps its look unchanged.

export { Card } from "./Card";
export { Row, ValueColumn } from "./Row";
export { StackHeader } from "./StackHeader";
export { usePullRefresh, pullRefresh, type PullRefreshState } from "./PullRefresh";
export { Sheet, SheetDoor, SHEET_RADIUS, SCRIM } from "./Sheet";
export { Chip, Pill, Button, IconButton } from "./Chip";
export { IconTile } from "./IconTile";
export { LogoMark, LOGO_MARK_SIZES } from "./LogoMark";
export { SectionHead, Eyebrow, LinkText, HerWords, RuledHead } from "./Bold";
// The density pass (DESIGN.md "Density: collapsed cards, decks and letters"): the white letter over a deck's foot and the
// collapsed section card that opens in place (one per group). The deck itself (ui/Deck: Deck, DeckPanel, DeckIdentity,
// DeckChip) is imported from its file, not from here — it draws its scrim with expo-linear-gradient, which the many
// suites that import this barrel do not mock.
export { LetterSheet, LetterBlock } from "./LetterSheet";
export { Accordion, AccordionGroup, useReducedMotion, animateExpand } from "./Accordion";
