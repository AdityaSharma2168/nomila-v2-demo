import { Platform, StyleSheet } from "react-native";

const primaryDark  = "#F05BA0";
const accentDark   = "#5BA8FF";

// The brand's ring colours (the logo's capitals). They paint the M.I.A. score, rings and logo ONLY (see `Ring`); the UI's
// one action colour is raspberry `Bold.act`, never these (DESIGN.md, one look, Oct 2026).
export const Brand = {
  ringBlue:  "#2D8EFF",
  ringGreen: "#2DC87C",
  ringPink:  "#E84591",
  ringGold:  "#E8A215",
  heroBg:    "#0D0B08",
} as const;

/**
 * Bold — the one look (DESIGN.md, owner 22–23 Oct 2026): the tokens every surface and the shell read. White
 * surfaces, black and white, photo-led, ONE raspberry action colour (`act`), pill buttons and 16 cards. `Colors.light`
 * (the legacy palette) is pointed at these values too.
 *
 *   ink · paper · ground · line · mute · quiet     the greys, from text to track
 *   act · onAct · actSoft                          the ONE action colour, the label on it, its soft tint
 *   blue                                           (historic name) links and Active, now in the text colour
 *   onDark*                                        ink on the black block and on photo scrims
 *   scrim*                                         the photo hero's top-and-foot scrim; cardScrim the photo card's foot
 *   radius                                         pills for buttons/chips/inputs · 16 cards and tiles · 0 photos
 */
export const Bold = {
  ink:          "#0E0E0E",
  ink2:         "#3A3A3A",
  mute:         "#6B6B6B",
  quiet:        "#9A9A98",
  line:         "#E4E4E2",
  ground:       "#F3F3F1",
  paper:        "#FFFFFF",
  blue:         "#0E0E0E",
  blueOnDark:   "#FFFFFF",
  onDark:       "#FFFFFF",
  onDarkSoft:   "rgba(255,255,255,0.92)",
  onDarkLabel:  "rgba(255,255,255,0.7)",
  onDarkMute:   "rgba(255,255,255,0.6)",
  lineOnDark:   "rgba(255,255,255,0.14)",
  track:        "#E9E9E7",
  heroBlank:    "#2A2A2A",
  scrimTop:     "rgba(0,0,0,0.45)",
  scrimClear:   "rgba(0,0,0,0)",
  scrimMid:     "rgba(0,0,0,0.08)",
  scrimFoot:    "rgba(0,0,0,0.78)",
  scrimDeep:    "rgba(0,0,0,0.86)",
  cardScrim:    "rgba(0,0,0,0.82)",
  wordOutline:  "rgba(255,255,255,0.3)",
  /** DESIGN.md §11 Modal / Sheet: the overlay behind a sheet, and a sheet's top corners (the one radius above 6). */
  sheetScrim:   "rgba(0,0,0,0.5)",
  sheetRadius:  20,
  /**
   * Bold + rounded (designer verdict, 22 Oct 2026, PREVIEW): chips, inputs, segmented controls and buttons are full
   * pills; text cards and tiles 16; sheets 20 at the top; photos and photo-led headers stay square (photo: 0).
   */
  radius:       { none: 0, chip: 999, control: 16, card: 16, pill: 999, photo: 0 },
  /** The ONE action colour on the Bold base (white uppercase label on it, 5.17:1); never small text on black. */
  act:          "#C8325A",
  onAct:        "#FFFFFF",
  /** The action colour's light tint: a picked (not main) tile or chip behind raspberry ink and a raspberry line. */
  actSoft:      "#FCEEF2",
  button:       48,
  buttonSmall:  34,
  chip:         24,
  gutter:       16,
  pressScale:   0.98,
  /**
   * The density pass (DESIGN.md "Density: collapsed cards, decks and letters"): the deck's pages and the letter over
   * its foot. `height` 372 · the letter overlaps by `overlap` 24, so anything anchored to a page's foot sits at `foot` 40.
   * Scrim 5% → 30% → 72% top to bottom; facts on the solid panel (black 66%, a 1px white 16% line) — never a blur (§6).
   */
  deck: {
    height:      372,
    overlap:     24,
    foot:        40,
    scrimTop:    "rgba(0,0,0,0.42)",  // the white back link must read on any cover, light ones included
    scrimMid:    "rgba(0,0,0,0.30)",
    scrimFoot:   "rgba(0,0,0,0.72)",
    panel:       "rgba(14,14,14,0.66)",
    panelLine:   "rgba(255,255,255,0.16)",
    pill:        "rgba(255,255,255,0.88)",
    counter:     "rgba(0,0,0,0.55)",
    counterLine: "rgba(255,255,255,0.22)",
    chip:        "rgba(255,255,255,0.18)",
    chipLine:    "rgba(255,255,255,0.35)",
    chipBlue:    "rgba(45,107,255,0.35)",
  },
} as const;

/**
 * Accent — the brand colours back as ACCENTS on the v3 surfaces only (EXPO_PUBLIC_HOME_V3; UX flow v3 "Alive", 19 Oct
 * 2026). Look B stays the ground (ink, paper, greys); these mark meaning, never decoration:
 *
 *   pink    actions (the one primary button on a card or story), "new" rings, "needs you" badges
 *   gold    wins and the score (DESIGN.md §2d)
 *   green   done and money in — ink now (one look, 23 Oct 2026: the ring green paints the score only)
 *   blue    links — ink now, like every link in the one look
 *   hero    full-screen stories and the M.I.A. card
 *
 * Nothing reads these with the flag off.
 */
export const Accent = {
  // The ONE action colour (owner, 23 Oct 2026): raspberry, not the ring pink. The ring pink stays on the score only.
  pink:      "#C8325A",
  pinkDeep:  "#9B1F45",
  /** The action colour as small text on black (raspberry alone is 4.1:1 there; this is ≥ 4.5:1). */
  pinkOnDark: "#FF6B8F",
  pinkSoft:  "#FFD2E6",
  gold:      Brand.ringGold,
  goldSoft:  "#FFF6E5",
  /** The deep end of a gold card's gradient (a payment on Home's hero). */
  goldDeep:  "#8A5B10",
  goldLine:  "#F3DFB6",
  green:     Bold.ink,
  blue:      Bold.ink,
  hero:      Brand.heroBg,
  seen:      "#CFC8BF",
  /** An offer poster's soft pink glow (top-left, fading out). */
  pinkGlow:  "rgba(200,50,90,0.38)",
  /** The brand's name as oversized texture on hero black. */
  texture:   "rgba(255,255,255,0.10)",
  /** A story's close button: its hit circle on any photo. */
  closeDisc: "rgba(0,0,0,0.25)",
  /** Dark glass over a photo (Studio's feed overlay, Home's hero buttons): the wash over the blur (iOS), and the tinted
   * stand-in where blur is off (Android, Reduce Transparency). */
  glassDark: "rgba(14,14,14,0.30)",
  glassDarkSolid: "rgba(14,14,14,0.72)",
  glassLight: "rgba(255,255,255,0.18)",
  glassEdge: "rgba(255,255,255,0.16)",
  /** A moment with no picture: its kind's card (Studio and Home), deep enough for white type. */
  momentGround: {
    holiday_awareness: ["#5E2C07", "#C27A1E"],
    league:            ["#0D2350", "#2D6BD8"],
    cultural_trend:    ["#4E0F2E", "#C2346F"],
    schedule:          ["#0E2419", "#2D8A5B"],
    partner_campaign:  ["#33240A", "#B88A2E"],
  } as Record<string, readonly [string, string]>,
  /** The kind word as faint texture on a moment card. */
  momentTexture: "rgba(255,255,255,0.12)",
} as const;

// The M.I.A. ring's spec (dimension → capital, the two tones per capital, gap, stroke) lives in constants/ring.ts — the
// ONE constant, React-free so the logic module can read it. Re-exported here for the components.
export { Ring, type RingCapital } from "./ring";

export const Colors = {
  /**
   * The legacy palette, pointed at the one look (owner, 22–23 Oct 2026): white grounds and Bold's greys, no cream,
   * `primary` = the ONE raspberry action colour (Bold.act). Ring colours live in constants/ring.ts and never here.
   * Light only for now: there is no dark mode (the `dark` block below is kept for type shape and is never selected).
   */
  light: {
    text: Bold.ink,
    textSecondary: Bold.ink2,
    textMuted: Bold.mute,
    // Meta lines, chips and icons. ~2.8:1 on white: captions and chips only — a sentence someone has to read takes
    // textMuted (4.5:1+).
    textQuiet: Bold.quiet,
    // Ink on the dark hero ground (the deck, the Deck screen).
    onHero: Bold.onDark,
    // The full-bleed photo hero (Me, What Nomila Knows, My Story, My Intelligence — components/me/MeHero):
    // the ground under the photo, the blank when there is no photo, the scrim that keeps the ink legible,
    // and the glass card that sits on the photo.
    heroGround: "#0D0B08",
    heroBlank: Bold.heroBlank,
    heroScrimTop: "rgba(13,11,8,0.05)",
    heroScrimMid: "rgba(13,11,8,0.25)",
    heroScrimBottom: "rgba(13,11,8,0.82)",
    heroGlass: "rgba(13,11,8,0.42)",
    heroGlassBorder: "rgba(255,255,255,0.18)",
    buttonText: Bold.onAct,
    tabIconDefault: "#717171",
    tabIconSelected: Bold.act,
    // Links read in the text colour (Bold); the blue was the ring's and the ring colours are the score's only.
    link: Bold.ink,
    primary: Bold.act,
    primaryLight: Bold.actSoft,
    accent: Bold.ink,
    backgroundRoot: Bold.paper,
    backgroundDefault: Bold.ground,
    backgroundSecondary: Bold.track,
    backgroundTertiary: Bold.line,
    card: Bold.paper,
    cardElevated: Bold.paper,
    border: Bold.line,
    borderLight: Bold.ground,
    success: "#10B981",
    successLight: "#D1FAE5",
    warning: "#F59E0B",
    warningLight: "#FEF3C7",
    error: "#EF4444",
    errorLight: "#FEE2E2",
    destructive: "#DC2626",
    statusPending: "#EAB308",
    statusNegotiating: "#3B82F6",
    statusAccepted: "#22C55E",
    statusDeclined: "#EF4444",
    statusArchived: "#6B7280",
    typeCommercial: "#16A34A",
    typeMedia: "#2563EB",
    typeEditorial: "#7C3AED",
    typeTrade: "#EA580C",
    priorityHigh: "#DC2626",
    priorityMedium: "#CA8A04",
    priorityLow: "#6B7280",
    sentimentPositive: "#22C55E",
    sentimentNeutral: "#F59E0B",
    sentimentFlagged: "#EF4444",
    sentimentHighValue: "#3B82F6",
    youtube: "#FF0000",
    instagram: "#E1306C",
    tiktok: "#000000",
  },
  dark: {
    text: "#ECEDEE",
    textSecondary: "#A0AEC0",
    textMuted: "#718096",
    textQuiet: "#8F887E",
    onHero: "#F3EEE4",
    heroGround: "#0D0B08",
    heroBlank: "#2A2622",
    heroScrimTop: "rgba(13,11,8,0.05)",
    heroScrimMid: "rgba(13,11,8,0.25)",
    heroScrimBottom: "rgba(13,11,8,0.82)",
    heroGlass: "rgba(13,11,8,0.42)",
    heroGlassBorder: "rgba(243,238,228,0.18)",
    buttonText: "#FFFFFF",
    tabIconDefault: "#9BA1A6",
    tabIconSelected: primaryDark,
    link: accentDark,
    primary: primaryDark,
    accent: accentDark,
    backgroundRoot: "#0D0B08",
    backgroundDefault: "#131D35",
    backgroundSecondary: "#1C2A47",
    backgroundTertiary: "#253759",
    card: "#131D35",
    cardElevated: "#1C2A47",
    border: "#2D3748",
    borderLight: "#1A202C",
    success: "#34D399",
    warning: "#FBBF24",
    error: "#F87171",
    destructive: "#EF4444",
    sentimentPositive: "#22C55E",
    sentimentNeutral: "#F59E0B",
    sentimentFlagged: "#EF4444",
    sentimentHighValue: "#3B82F6",
  },
};

export const Spacing = {
  xs:  4,
  sm:  8,
  md:  12,
  lg:  16,
  xl:  20,
  "2xl": 24,
  "3xl": 32,
  "4xl": 40,
  "5xl": 48,
  inputHeight: 48,
  buttonHeight: 52,
};

export const BorderRadius = {
  xs:   10,
  sm:   14,
  md:   20,
  lg:   28,
  xl:   36,
  "2xl": 44,
  "3xl": 52,
  full: 9999,
};

export const Typography = {
  display:    { fontSize: 32, lineHeight: 40, fontWeight: "800" as const, letterSpacing: -0.5 },
  h1:         { fontSize: 26, lineHeight: 32, fontWeight: "700" as const, letterSpacing: -0.3 },
  h2:         { fontSize: 22, lineHeight: 28, fontWeight: "700" as const, letterSpacing: -0.2 },
  h3:         { fontSize: 18, lineHeight: 24, fontWeight: "600" as const },
  h4:         { fontSize: 16, lineHeight: 22, fontWeight: "600" as const },
  body:       { fontSize: 16, lineHeight: 24, fontWeight: "400" as const },
  bodyMedium: { fontSize: 16, lineHeight: 24, fontWeight: "500" as const },
  small:      { fontSize: 14, lineHeight: 20, fontWeight: "400" as const },
  caption:    { fontSize: 12, lineHeight: 16, fontWeight: "500" as const, letterSpacing: 0.2 },
  // DESIGN.md 3b: uppercase labels and eyebrows.
  label:      { fontSize: 11, lineHeight: 14, fontWeight: "600" as const, letterSpacing: 0.5 },
  link:       { fontSize: 16, lineHeight: 24, fontWeight: "600" as const },
};

export const Fonts = {
  display:        "Outfit_800ExtraBold",
  displayBold:    "Outfit_700Bold",
  heading:        "Outfit_700Bold",
  headingSemiBold:"Outfit_600SemiBold",
  body:           "Outfit_400Regular",
  bodyMedium:     "Outfit_500Medium",
  bodySemiBold:   "Outfit_600SemiBold",
  bodyBold:       "Outfit_700Bold",
  // The editorial display face (Instrument Serif, loaded in App.tsx): statements, section titles, her name, the
  // M.I.A. number. `serif` below is the platform serif that LEGACY screens still read; the Concept 0.4 surfaces use
  // the `Type` roles and never it (visual rules, Oct 2026).
  editorial:      "InstrumentSerif_400Regular",
  editorialItalic:"InstrumentSerif_400Regular_Italic",
  ...Platform.select({
    ios: {
      sans:    "system-ui",
      serif:   "ui-serif",
      rounded: "ui-rounded",
      mono:    "ui-monospace",
    },
    default: {
      sans:    "Outfit_400Regular",
      serif:   "serif",
      rounded: "Outfit_400Regular",
      mono:    "monospace",
    },
    web: {
      sans:    "Outfit, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      serif:   "Georgia, 'Times New Roman', serif",
      rounded: "Outfit, system-ui, sans-serif",
      mono:    "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
    },
  }),
};

/** DESIGN.md 3c: every weight is paired with its Outfit family, or the weight does not apply on iOS. */
const OUTFIT: Record<"400" | "500" | "600" | "700" | "800" | "900", string> = {
  "400": "Outfit_400Regular", "500": "Outfit_500Medium", "600": "Outfit_600SemiBold", "700": "Outfit_700Bold", "800": "Outfit_800ExtraBold", "900": "Outfit_900Black",
};
const role = <T extends { fontWeight: keyof typeof OUTFIT }>(t: T) => ({ ...t, fontFamily: OUTFIT[t.fontWeight] });
/** The Outfit family for a weight, for text drawn outside a type role (a canvas, a composed tile). */
export const outfitFamily = (w: keyof typeof OUTFIT): string => OUTFIT[w];

type Weight = keyof typeof OUTFIT;
const UPPER = { textTransform: "uppercase" as const };
/** One Bold role: size / weight, line height, tracking, with the matching Outfit family (and the uppercase transform where the spec says so). */
const bold = (fontSize: number, fontWeight: Weight, lineHeight: number, letterSpacing = 0, upper = false) =>
  ({ fontSize, fontWeight, lineHeight, letterSpacing, fontFamily: OUTFIT[fontWeight], ...(upper ? UPPER : {}) });

/**
 * BoldType — look B's type roles (DESIGN.md §3, Oct 2026): Outfit only, 400–900. Display, screen titles, section heads,
 * photo-card titles, chips and buttons are UPPERCASE by transform (the copy stays sentence case). Her words take
 * `herWords` and nothing of Nomila's does. The Concept 0.4 surfaces spread these and never type a size of their own.
 *
 *   display · displaySm · screenTitle · screenTitleSm   hero headlines and tab-root titles (36–40 / 900, −1px)
 *   bigNumber · statement · bannerTitle · glanceTitle   the loud numbers and statements
 *   section (17/900 caps) · cardTitle (18/800 caps)     section heads · photo-card titles
 *   h4 · rowTitle · rowMeta · body · read · lede        reading text (15/400, line 1.45)
 *   herWords (16/600) · goal (18/800) · goalSm          anything she said; her goals in her cards
 *   label (11/800 caps .12em) · caption (12/500)         eyebrows · dates, provenance, meta
 *   chip (10/900 caps) · chipLine (12/700) · button (13/800 caps) · buttonSmall · link (13/800)
 *   wordmark · backLabel · tab · segment                 the shell
 */
export const BoldType = {
  display:       bold(40, "900", 37, -1.2, true),
  displaySm:     bold(28, "900", 27, -0.6, true),
  screenTitle:   bold(34, "900", 32, -1, true),
  screenTitleSm: bold(26, "900", 26, -0.5, true),
  bigNumber:     bold(48, "900", 44, -2),
  statement:     bold(24, "900", 26, -0.5, true),
  bannerTitle:   bold(18, "900", 20, -0.2, true),
  glanceTitle:   bold(22, "900", 23, -0.4, true),
  cellValue:     bold(20, "900", 22, -0.5),
  section:       bold(17, "900", 19, 0.34, true),
  cardTitle:     bold(18, "800", 18, -0.3, true),
  h4:            bold(15, "800", 19),
  rowTitle:      bold(15, "700", 19),
  rowMeta:       bold(13, "400", 18),
  body:          bold(15, "400", 22),
  read:          bold(15, "500", 21),
  lede:          bold(14, "400", 20),
  heroLine:      bold(17, "600", 22),
  heroLineSmall: bold(14, "500", 20),
  herWords:      bold(16, "600", 22),
  goal:          bold(18, "800", 23, -0.2),
  goalSm:        bold(15, "700", 20),
  headedTitle:   bold(19, "800", 24, -0.2),
  label:         bold(11, "800", 13, 1.32, true),
  herLabel:      bold(10, "800", 12, 1.2, true),
  caption:       bold(12, "500", 16),
  chip:          bold(10, "900", 12, 0.8, true),
  chipLine:      bold(12, "700", 14),
  button:        bold(13, "800", 15, 1.04, true),
  buttonSmall:   bold(11, "800", 13, 0.88, true),
  link:          bold(13, "800", 15),
  wordmark:      bold(13, "900", 15, 4.4),
  backLabel:     bold(11, "800", 13, 1.76, true),
  tab:           bold(10, "700", 12, 0.2),
  segment:       bold(12, "800", 14, 0.72, true),
  sigLabel:      bold(13, "600", 16),
  sigMeta:       bold(11, "500", 13),
  sigValue:      bold(14, "900", 16),
  outOf:         bold(10, "800", 12, 1.2, true),
  // The card system v2 (DESIGN.md §16 "Mila cards"): a tighter scale inside a card, so it never matches Mila's 15/23
  // reading text — headline 17/800 · line 14/500 · meta 12/500 · the frosted kind chip 10/800 caps.
  cardHeadline:  bold(17, "800", 22, -0.2),
  cardLine:      bold(14, "500", 20),
  cardMeta:      bold(12, "500", 16),
  cardKind:      bold(10, "800", 12, 1, true),
  cardBig:       bold(30, "900", 30, -1),
  cardOption:    bold(15, "600", 20),
} as const;
export type BoldTypeRole = keyof typeof BoldType;

/**
 * Type — the LEGACY type scale (DESIGN.md 3b before look B) as spreadable styles: `Typography` with the matching Outfit
 * family on each role. The kit's legacy variants and the screens not yet on look B read it; the Concept 0.4 surfaces
 * read `BoldType`. Outfit only; the serif stays loaded for older screens and is never read here.
 *
 *   display      hero headlines · her name · the score number
 *   h1           screen titles                 h2   section headers ("What defines you", "Your plan")
 *   h3           card titles                   h4   subsection headers, in-card headings, row titles
 *   body · bodyMedium · small · caption        label  uppercase labels and eyebrows (the copy stays sentence case)
 *   chip         DESIGN.md Chip: 12 SemiBold   action  small text actions ("See all 3", "Why?", a row's button)
 *
 * Her words ("In your words", "You said") take BoldType.herWords behind the blue rule on look B; Nomila's text never does.
 */
export const Type = {
  display:    role(Typography.display),
  h1:         role(Typography.h1),
  h2:         role(Typography.h2),
  h3:         role(Typography.h3),
  h4:         role(Typography.h4),
  body:       role(Typography.body),
  bodyMedium: role(Typography.bodyMedium),
  small:      role(Typography.small),
  caption:    role(Typography.caption),
  label:      { ...role(Typography.label), textTransform: "uppercase" as const },
  chip:       { ...role(Typography.caption), fontWeight: "600" as const, fontFamily: OUTFIT["600"], letterSpacing: 0 },
  action:     { ...role(Typography.small), fontWeight: "600" as const, fontFamily: OUTFIT["600"] },
} as const;
export type TypeRole = keyof typeof Type;

const createShadow = (offsetY: number, blur: number, opacity: number, elevation: number) =>
  Platform.select({
    web: { boxShadow: `0px ${offsetY}px ${blur}px rgba(0, 0, 0, ${opacity})` },
    default: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: offsetY },
      shadowOpacity: opacity,
      shadowRadius: blur / 2,
      elevation,
    },
  });

export const Shadows = {
  // The deal card's shadow (offset 2, radius 8, 7%) — the one every card uses from the kit on.
  card: createShadow(2, 16, 0.07, 3),
  sm: createShadow(1,  4,  0.05, 1),
  md: createShadow(2,  8,  0.10, 3),
  lg: createShadow(4,  16, 0.15, 5),
  xl: createShadow(8,  32, 0.20, 8),
};

/**
 * Tint — one background/foreground pair per MEANING, never decoration. A chip states a fact
 * about its row (who said it, whether a rate is verified, what stage a deal is in); the tint
 * is the fact's colour. These were six hex pairs typed by hand across Brand, Rates and Facts.
 */
export const Tint = {
  said:      { bg: "#E7F4EC", fg: "#1A9960" },  // the athlete's word
  found:     { bg: "#EAF2FD", fg: "#2D6FD1" },  // research / connected accounts
  made:      { bg: "#F1EAFB", fg: "#7A4FC2" },  // Mila wrote it
  proof:     { bg: "#F4ECDB", fg: "#C4850D" },  // a contract, an accepted deal
  none:      { bg: "#F1ECE6", fg: "#9C968D" },  // not yet / neutral (tiers, archived)
  verified:  { bg: "#E7F4EC", fg: "#1A9960" },
  estimated: { bg: "#F4ECDB", fg: "#C4850D" },
  stage:     { bg: "#FCEEF2", fg: "#C8325A" },  // a live deal stage (the action tint)
} as const;
export type TintName = keyof typeof Tint;

/**
 * Look — the tokens the bookings sheets/cards use. REVISED 22 Oct 2026 by the owner: the app is BOLD (black/white,
 * photo-led) with Nomila colours that mean something and rounded shapes; the cream "Lively" ground was rejected, so
 * Look's light palette now IS Bold's (white ground, Bold inks/lines). Light only for now (`useLook()`; 23 Oct 2026). Bold stays the base system; its discipline holds: one colour per meaning, neutral surfaces,
 * photos carry the emotion, near-black text.
 *
 *   act       raspberry-coral: the ONE action colour (buttons, "new" rings, needs-you badges). Fills with `onAct` text,
 *             or as text ≥ 4.5:1 on white. Never pastel.
 *   gold      wins and the score       green  money and done       blue  links ("See all", web links)
 *   *Tint / *Ink   a soft fill and the ink that reads on it (chips, "You get" panels)
 *
 * The M.I.A. card, the score reveal and stories stay DARK in both themes (`hero`). Contrast: every text pair ≥ 4.5:1;
 * colour is never the only signal (pair it with a word or icon); targets ≥ 44pt; body ≥ 16px.
 */
const LOOK_LIGHT = {
  bg:         "#FFFFFF",
  card:       "#FFFFFF",
  ink:        "#0E0E0E",
  ink2:       "#3A3A3A",
  muted:      "#6B6B6B",
  line:       "#E4E4E2",
  act:        "#C8325A",
  onAct:      "#FFFFFF",
  actTint:    "#FCE7EE",
  actTintInk: "#9B1F45",
  gold:       "#C9A86A",
  goldTint:   "#FBF1D9",
  goldInk:    "#7A5A10",
  green:      "#0E0E0E",
  greenTint:  "#F3F3F1",
  blue:       "#0E0E0E",
  glass:      "rgba(255,255,255,0.72)",
  scrim:      "rgba(0,0,0,0.45)",
  hero:       "#0D0B08",
  onHero:     "#FFFFFF",
} as const;
export type LookPalette = { [K in keyof typeof LOOK_LIGHT]: string };
const LOOK_DARK: LookPalette = {
  bg:         "#0E0E0E",
  card:       "#1A1A1A",
  ink:        "#F4F4F2",
  ink2:       "#B8B8B5",
  muted:      "#9A9A98",
  line:       "#2B2B2D",
  act:        "#FF6B8F",
  onAct:      "#0E0E0E",
  actTint:    "#3A1622",
  actTintInk: "#FF9CB5",
  gold:       "#F2C14E",
  goldTint:   "#33280F",
  goldInk:    "#F2C14E",
  green:      "#F4F4F2",
  greenTint:  "#1A1A1A",
  blue:       "#F4F4F2",
  glass:      "rgba(26,26,26,0.72)",
  scrim:      "rgba(0,0,0,0.6)",
  hero:       "#0D0B08",
  onHero:     "#FFFFFF",
};
export const Look = {
  light: LOOK_LIGHT as LookPalette,
  dark:  LOOK_DARK,
  /** Pills for buttons and chips; 16 for text cards and tiles; 20 for a sheet's top corners. */
  radius: { pill: 999, card: 16, sheet: 20, tile: 16, chip: 999 },
  button:      52,
  buttonSmall: 44,
  chip:        44,
  gutter:      16,
  pressScale:  0.98,
  /** The 10-second Undo window that replaces "Are you sure?" on reversible taps. */
  undoMs:      10_000,
  type: {
    title:   { fontFamily: "Outfit_800ExtraBold", fontSize: 28, lineHeight: 32 },
    heading: { fontFamily: "Outfit_700Bold", fontSize: 20, lineHeight: 26 },
    body:    { fontFamily: "Outfit_400Regular", fontSize: 16, lineHeight: 22 },
    bodyStrong: { fontFamily: "Outfit_600SemiBold", fontSize: 16, lineHeight: 22 },
    meta:    { fontFamily: "Outfit_400Regular", fontSize: 14, lineHeight: 19 },
    label:   { fontFamily: "Outfit_700Bold", fontSize: 12, lineHeight: 16, letterSpacing: 1.2, textTransform: "uppercase" as const },
    button:  { fontFamily: "Outfit_800ExtraBold", fontSize: 14, lineHeight: 18, letterSpacing: 1, textTransform: "uppercase" as const },
    money:   { fontFamily: "Outfit_800ExtraBold", fontSize: 28, lineHeight: 32 },
    // Smaller roles the restyled screens share (so no screen types a size of its own).
    metaStrong:  { fontFamily: "Outfit_600SemiBold", fontSize: 14, lineHeight: 19 },
    metaBold:    { fontFamily: "Outfit_700Bold", fontSize: 14, lineHeight: 19 },
    bodyBold:    { fontFamily: "Outfit_700Bold", fontSize: 16, lineHeight: 21 },
    buttonSmall: { fontFamily: "Outfit_700Bold", fontSize: 15, lineHeight: 19 },
    badge:       { fontFamily: "Outfit_700Bold", fontSize: 12, lineHeight: 14 },
    badgeSmall:  { fontFamily: "Outfit_700Bold", fontSize: 10, lineHeight: 12 },
    wordmark:    { fontFamily: "Outfit_700Bold", fontSize: 17, lineHeight: 22, letterSpacing: 5 },
    /** A date or initial drawn as a face (circles, thumbs): heavy italic. */
    face:        { fontFamily: "Outfit_800ExtraBold", fontSize: 26, lineHeight: 30, fontStyle: "italic" as const },
    faceTop:     { fontFamily: "Outfit_800ExtraBold", fontSize: 10, lineHeight: 12, letterSpacing: 1, fontStyle: "italic" as const },
    /** A card's headline over a picture. */
    cardTitle:   { fontFamily: "Outfit_700Bold", fontSize: 22, lineHeight: 27 },
    /** A big money figure on a poster card. */
    amount:      { fontFamily: "Outfit_800ExtraBold", fontSize: 40, lineHeight: 44, letterSpacing: -1 },
    /** A brand's name as faint texture behind a poster card. */
    texture:     { fontFamily: "Outfit_800ExtraBold", fontSize: 64, lineHeight: 68, letterSpacing: -2 },
  },
} as const;

/** The card shadow: wide and soft, never a border-and-shadow stack. */
export const LookShadow = {
  light: createShadow(8, 24, 0.08, 4),
  dark:  createShadow(8, 24, 0.4, 6),
};

/**
 * The current look. LIGHT ONLY for now (owner, 23 Oct 2026: no dark mode yet), whatever the phone's setting; the dark
 * palette stays defined so turning it on later is one line here.
 */
export function useLook(): LookPalette & { dark: boolean; shadow: object } {
  return { ...LOOK_LIGHT, dark: false, shadow: LookShadow.light };
}

/** The palette a themed style sheet is built from (`useLook()`'s value). */
export type LookTheme = ReturnType<typeof useLook>;

/**
 * A style sheet built from the one look: `build` runs once per theme (cached), and the returned hook hands a component
 * the sheet (always the light one while the app is light only). For screens whose colours live in many styles.
 */
export function makeLookStyles<T extends StyleSheet.NamedStyles<T>>(build: (L: LookTheme) => T): () => T {
  const cache: { light?: T; dark?: T } = {};
  return function useLookStyles(): T {
    const L = useLook();
    const k = L.dark ? "dark" : "light";
    return (cache[k] ??= StyleSheet.create(build(L)));
  };
}
