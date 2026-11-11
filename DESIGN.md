# DESIGN.md — Nomila Design System

> **For AI tools**: This file is the single source of truth for all visual design decisions in Nomila.
> Read this before generating or modifying any UI code across all three surfaces.
>
> **Three surfaces**: Native mobile (Expo React Native · iOS + Android), Mobile web (responsive HTML/CSS), Web desktop (HTML/CSS).
>
> **Current look: "the one look"** (agreed by the owner 22–23 Oct 2026; it evolves look B of 5 Oct). Bold black and
> white, photo-led, Outfit only; **white** grounds (no cream); **ONE raspberry action colour** `#C8325A` for the main
> action on a screen, as a rounded **pill** with a white label; secondary actions are soft grey or black-outline pills;
> text cards and tiles at **corner 16**; the **M.I.A. card is dark everywhere**; ring colours only on the M.I.A.
> score, its rings and the logo; **light mode only** for now. The brand book is in the one look too (owner, 23 Oct
> 2026; it was the Luxe document look). The legacy palette (`Colors.light`, the opps `N` tokens) is pointed at these values, so screens not
> yet rebuilt on the kit still read white, Bold greys and raspberry.

---

## 0. The one look in ten rules

1. **White ground** `#FFFFFF` on every screen; Bold's greys for grounds, lines and secondary text. No cream anywhere.
2. **One action colour**: raspberry `Bold.act` `#C8325A` (soft tint `Bold.actSoft` `#FCEEF2`, deep ink `#9B1F45`).
   It fills the ONE main action per screen or card, as a pill with a white label (5.17:1). A picked tile or a
   "needs you" chip takes the soft tint with raspberry ink and a raspberry line.
3. **Secondary actions** are soft grey (`Bold.ground`) or black-outline pills; a black filled pill is for a strong
   but not-main action (Share, Paste). Never a second raspberry on the same card.
4. **Pills** for buttons, chips and inputs (`Bold.radius.pill`); **16** for text cards and tiles
   (`Bold.radius.card`); **20** for a sheet's top corners; photo-led headers full-bleed and square.
5. **Photo-led**: her photos where the content is about her, atmosphere elsewhere (§9), under the scrims (§2c).
6. **The M.I.A. card is dark** (`Bold.ink`, white type, the ring on black with its glow) on Home, Me and My
   Intelligence alike.
7. **Ring colours** (§2b) paint the M.I.A. score, its rings, its legend and the logo — nothing else.
8. **Button labels are UPPERCASE by transform** (`BoldType.button` 13/800, `BoldType.buttonSmall` 11/800,
   `Look.type.button`): the copy in code stays sentence case. Applies to every pill that acts — main and secondary,
   on cards, sheets and screens, Home's briefing chips included. Not buttons, and so sentence case: things she
   *says* (Mila's composer suggestions, openers, follow-ups), text links (`LinkText`), the sign-in provider buttons
   ("Continue with Google", platform convention) and status chips set in `chipLine`.
9. **Light mode only** (`app.json` `userInterfaceStyle: light`; `useLook()` always returns the light palette; legacy
   `Colors.light` everywhere). The dark palettes stay defined, unused, until dark mode is wanted.
10. **The brand book is the one look, kept premium by its structure** (owner, 23 Oct 2026; it was Luxe): white
    pages, Outfit only (names and titles in 900 capitals, long written lines in sentence case), raspberry for the one
    action or highlight, 16 cards, square photos; full-bleed hero pages, one idea per screen, the face-aware crop and
    the big name stay, and the cover, the photo pages and the score card sit on the dark ground (the M.I.A. card's).
    Photos take the neutral "campaign" grade. The Nomila mark is on every page: the cardmark + "Nomila · Brand book"
    on the cover, a small mark + "Nomila" in each page's foot, the faint rings watermark on white pages
    (`components/book/mark.tsx`; guarded by `components/book/bookLook.test.ts`).

---

## 1. Brand Identity

**Product**: Nomila — AI-powered athlete brand management. Helps athletes monetize their NIL (Name, Image, Likeness).

**Positioning**: *"Your brand is a media business."* Athletic (energy, dynamism) and professional (a tool where real
money moves). Closer to Stripe-for-athletes than to a fitness app. Imagery is full-bleed under confident type, but the
app is **not her photo gallery**: her own photos lead only where the content is about her (§9).

**Logo mark**: Four concentric arc rings — these ARE the brand. The rings represent the four capitals of athlete
marketability (Audience, Commercial, Brand, Performance). On screen the ring is the M.I.A. score's data visualisation
(§10) and the four-arc mark sits in the shell's centre tab; the ring colours are **data only** and never UI colour.

**Key rule**: a ring colour on screen always means a part of the score. The one UI colour is raspberry, for the main
action. Everything else is ink, paper and grey.

---

## 2. Color Tokens

### 2a. Palette (`Bold` in `client/constants/theme.ts`)

```
--ink:       #0E0E0E   /* text, buttons, tiles, the black block */
--ink-2:     #3A3A3A   /* reading text */
--mute:      #6B6B6B   /* secondary text, captions, eyebrows */
--quiet:     #9A9A98   /* inactive tabs, chevrons, placeholders */
--line:      #E4E4E2   /* borders, dividers */
--ground:    #F3F3F1   /* chips, cells, soft rows, grey tiles */
--paper:     #FFFFFF   /* surfaces, screen background */
--act:       #C8325A   /* THE ONE ACTION COLOUR: the main pill per screen/card, "new" rings, needs-you badges */
--act-soft:  #FCEEF2   /* its tint: a picked tile or chip, a needs-you chip (ink #9B1F45 on it) */
--on-act:    #FFFFFF   /* the label on raspberry */
--blue:      #0E0E0E   /* historic name: links and Active now read in the text colour */
--track:     #E9E9E7   /* the ring's neutral track on white */
```

The legacy `Colors.light` palette maps onto these: `backgroundRoot`/`card` → paper, `backgroundDefault` → ground,
`backgroundSecondary` → track, `border` → line, `text`/`textSecondary`/`textMuted`/`textQuiet` → ink/ink-2/mute/quiet,
`primary` → act, `primaryLight` → act-soft, `link`/`accent` → ink. The opps `N` tokens do the same (`cream100` →
white, `cream200` → ground, `cream300/400` → line, `pink` → act).

On black (the score block, the banner, her direction, photo scrims): text `#FFFFFF`, soft `rgba(255,255,255,.92)`,
labels `.7`, muted `.6`, lines and the ring track `rgba(255,255,255,.14)`.

### 2b. Ring colours (data only — `client/constants/ring.ts`)

| Capital | Tone 1 | Tone 2 |
|---------|--------|--------|
| Audience | `#2D8EFF` | `#7DB8FF` |
| Commercial | `#2DC87C` | `#7FDDB0` |
| Brand | `#E84591` | `#F28DBB` |
| Performance | `#E8A215` | `#F2C76A` |

These appear in the ring's bands, the capital legend and the logo, nowhere else. **The ring pink is not a UI colour**
(the action colour is raspberry, a different hue). Goal categories (Impact, Positioning, Audience…) are neutral: a grey
tile, a white or black chip.

### 2c. Scrims

Photo hero: top `rgba(0,0,0,.45)` → clear at 32% → `.08` at 52% → foot `.78` (deep variant: `.86`, for a long
statement). Photo card: clear until 38% → `.82` at the foot.

### 2d. v3 accents (`Accent` in `client/constants/theme.ts`)

On the v3 surfaces (Home v3, Me v3, the story viewers, Opportunities' accents): `Accent.pink` IS the raspberry action
colour `#C8325A` (owner, 23 Oct 2026 — not the ring pink) for actions, "new" rings and "needs you" badges; **gold** for
wins and the score; **hero black** `#0D0B08` for full-screen stories and the M.I.A. card; white for everyday surfaces.
A ring is grey once everything in it is seen.

---

## 3. Typography

### 3a. Font Family

**Outfit, and only Outfit** (Google Fonts), 400–900. The 900 weight is new with look B and carries the display.

```
Native (Expo):  @expo-google-fonts/outfit
  Outfit_400Regular · Outfit_500Medium · Outfit_600SemiBold · Outfit_700Bold · Outfit_800ExtraBold · Outfit_900Black

Web / Mobile Web:
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap');
  font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```

### 3b. Type roles (`BoldType` in `client/constants/theme.ts`)

Uppercase is a **transform**; copy stays sentence case. Tracking in px (em × size).

| Role | Size / weight | Tracking · line | Use |
|------|---------------|-----------------|-----|
| display | 40 / 900 · uppercase | −1.2 · .92 | hero headlines ("GOOD MORNING, MIA") |
| displaySm | 28 / 900 · uppercase | −0.6 · .95 | a title over a photo, a long hero statement |
| screenTitle / screenTitleSm | 34 · 26 / 900 · uppercase | −1 · −0.5 | tab-root and pushed-screen titles |
| bigNumber | 48 / 900 | −2 | the score as a number (72 on web) |
| statement | 24 / 900 · uppercase | −0.5 · 1.1 | "What you stand for" |
| section | 17 / 900 · uppercase | .02em | section heads |
| cardTitle | 18 / 800 · uppercase | −0.3 · 1 | photo-card titles |
| rowTitle · rowMeta | 15 / 700 · 13 / 400 | | rows |
| h4 | 15 / 800 | | in-card headings |
| body · read · lede | 15 / 400 · 15 / 500 · 14 / 400 | 1.45 | reading text, Nomila's read, section ledes |
| herWords | 16 / 600 | 1.4 | **anything she said** (§11 Her words) |
| goal · goalSm | 18 / 800 · 15 / 700 | −0.2 | her goals in her cards |
| label | 11 / 800 · uppercase | .12em | eyebrows |
| caption | 12 / 500 | | dates, provenance, meta |
| chip · chipLine | 10 / 900 · uppercase · 12 / 700 | .08em | chips (filled · outlined) |
| button · buttonSmall · link | 13 / 800 · uppercase · 11 / 800 · 13 / 800 | .08em | actions, the blue link |
| wordmark · backLabel · tab · segment | 13 / 900 · 11 / 800 · 10 / 700 · 12 / 800 | .34em · .16em · · .06em | the shell |

### 3c. Platform Notes

**Native**: Set `fontFamily` explicitly on every `Text` via the theme — React Native does not inherit font-family.
Every weight is paired with its `Outfit_*` family or the weight will not apply on iOS. The Concept 0.4 surfaces spread
a role and never type a size of their own (`client/constants/outfitOnly.test.ts` enforces this at the source).

**Web**: Set `font-family` on `body`; `font-display: swap`.

---

## 4. Spacing

Scale is **universal** — same values on all three platforms: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40.

**Screen gutter**: 16px. Full-bleed elements (the hero, the black score block, the rail's scroll) run edge to edge;
everything else sits inside the gutter. Cards are padded 14; rows 12 × 14.

---

## 5. Corners

Rounded (the one look, 22 Oct 2026). `Bold.radius` / `Look.radius`:

| Value | Use |
|-------|-----|
| 0 | full-bleed photos and photo-led headers |
| pill (999) | buttons, chips, inputs, segmented controls |
| 16 | text cards, tiles, photo cards inside the gutter, the black blocks inside the gutter |
| 20 | a sheet's top corners |

Circles for avatars, the Mila disc and the rail's dots.

---

## 6. Elevation

Cards are white with a 1px `line` border, or the one look's soft wide card shadow (`LookShadow`) — never both.
Elevation is otherwise contrast: **one black block per screen** (the M.I.A. card, Strategy's waiting banner, My
Story's "Where you're headed"). Never blur on cards or backgrounds (the Mila surfaces' frost excepted, §16; and the web frame's photo backdrop, §14).

---

## 7. Motion & Animation

| Token | Value | Use |
|-------|-------|-----|
| fast  | 150ms | Micro-interactions (button press, toggle) |
| normal| 250ms | Standard transitions |
| slow  | 400ms | Entrances, reveals |
| crawl | 600ms | Ring fill |

- **Press feedback**: scale to **0.98**, 150ms — all tappable elements (buttons, photo cards, rows)
- Respect `prefers-reduced-motion`; `react-native-reanimated` for complex native motion; CSS transitions on web
- Easing: entrances `easeOut`, exits `easeIn`, spring `{ damping: 15, mass: 0.3, stiffness: 150 }`

---

## 8. Surface Contexts

### 8a. Photo hero (full-bleed)

An image edge to edge under the top-and-foot scrim (§2c), the shell's bar in white over the top scrim, the display type
at the foot. The image follows §9: **her own photo** when the screen is about her (Home, the Scouting report, "Is this
you?"), rotating **licensed athlete imagery** on sign-in, an **atmosphere** image otherwise (a section or empty-state
header), with its credit line. Blank ground
when there is no image: `#2A2A2A`. Never a dark "aurora".

### 8b. Light surface (every screen)

Background `#FFFFFF`, cards white at corner 16 with a 1px line, text ink / ink-2 / mute, the one raspberry pill for
the main action. This is the whole app interior, legacy screens included (their palette points here).

### 8c. The black block

One per screen at most: `#0E0E0E`, white type, white links. Full-bleed (Me's M.I.A. card) or corner 16 inside the
gutter (My Intelligence's score card, a banner, her direction). The M.I.A. card is always this block.

### 8d. The public page (Front Door)

Her page on the one look (owner, 23 Oct 2026) — `components/frontDoor/FrontDoorPage` in the app: a WHITE ground,
the top bar in ink (NOMILA · her handle · the visitor's heart, raspberry when liked), swipeable hero cards at corner 16
inside a 6 margin (Highlights on her own photo, then her chapters on atmosphere, under the scrims), the 2 × 2 doors as
corner-16 tiles (the FIRST door is the page's one raspberry action; the others grey; a dark "soon" door, Create, black)
with Mila at the centre in a white ring, and the Follow footer in ink. The visitor's web page
(`server/services/publicCard/render.ts` + `front.css`) still draws the earlier black-ground design until it follows.
Owner rules (10 Oct 2026):

- **Only the hero swipes; the doors never move.** When the page scrolls vertically the door grid stays pinned at the
  foot of the screen (beside the cards on desktop), so every door is always one tap away.
- **The heart** is one like per visitor (tap again to take it back). Visitors never see a count.
- **Her own view** adds the slim metrics rail on the right of the hero: views · likes · requests · bookings · shop,
  last 30 days. It waits for its numbers; never a zero that is not hers.
- **"Verified by Nomila"** is off (`SHOW_VERIFIED` in `shared/publicPageStats.ts`) until the owner decides.

---

## 9. Imagery

Owner decision, 10 Oct 2026: **the app must not look like her photo gallery.** Two kinds of image, chosen by what the
content is about.

- **Her own photos — only for content about her**: the Home hero, the Scouting report hero, "Is this you?", a
  performance goal, and a card that is literally about her photos. **Her face at most twice per screen.** ONE pool of
  her eligible library photos per screen; each use takes the next distinct one, never a repeat on the screen
  (`lib/myStoryLogic`).
- **Atmosphere — for everything else**: section headers, empty states, goal, suggestion and pitch backgrounds, and thin
  profiles (an athlete with too few photos of her own). Venues, surfaces, equipment, light and texture — **never a
  person, a logo or text**.
  - Source: Pixabay, as **stored copies** (never hot-linked) with a **credit line** on the image (caption 12/500 on the
    deck's solid panel, top-left); generation is the fallback when nothing fits.
  - A model picks the search terms from her sport and her data (venue, season, surface); an image check rejects any
    candidate showing a person, a logo or text before it is stored.
- **Sign-in is the one exception**: it is marketing, not an athlete's own content, so its full-bleed hero shows PEOPLE —
  **rotating licensed athlete imagery** (several images, a slow swap, the rail's dots), each with its credit line. The
  images and the sign-in words are configuration, swapped without a code change. Nowhere else does a person who is not
  her appear.
- **Image order for a card**: a brand cover when the view carries one (a brand's own subject) → her photo when the card
  is about her → atmosphere → the **category default** (always the last fallback).
- **Not yet migrated**: today's Me doors, My Story pillars, Strategy's goal and plan cards and the deck's image-only pages
  still draw from her pool (`lib/myStoryLogic`, `lib/goalLogic`); they move to atmosphere as each surface is next touched.
  The prototypes in `client/screens/prototypes` (dev gallery) show the target, with labelled placeholder atmosphere.
- **Me's illustrated tiles** (§13) are not imagery in this sense: Your plan, Your page and the brand book show her own
  photos because those tiles ARE her content, shown as objects (prints, a book, a page). Approved 20 Oct 2026 as an
  exception to the two-faces rule on Me; keep them small (tile size) so the screen still reads as hers, not a gallery.
- **Category default**: black ground, the category word outlined (`rgba(255,255,255,.3)`, 1.2px) running off the
  bottom-right edge, its Feather icon top-left at 22, and ONE blue geometric mark per category — Impact a diagonal
  band · Positioning a dot grid · Audience rising bars · Commercial a corner block · Performance a chevron
  (`components/strategy/RecommendationVisual.tsx`, `DOMAIN_MARK`).
- Thumbnails for tiles (40, corner 4); never the sign-in avatar as a hero.
- Gradients and the aurora are retired.

---

## 10. Ring Visualization (M.I.A.)

One ring of **eight bands** grouped under the four capitals (`client/constants/ring.ts` — the ONE constant holding
the dimension → capital mapping and the colours).

- Bands run **from 12 o'clock clockwise**: Audience → Commercial → Brand → Performance (the logo's outer-to-inner
  order), each capital's two dimensions in its two tones.
- Band length = the dimension's **stored contribution** (score × weight, of 100, served in my-intelligence/0.2);
  nothing is recomputed. The unfilled share is a neutral track (`#E9E9E7` on white, `rgba(255,255,255,.14)` on black).
- **2.6° gaps**, butt caps, stroke ≈ **9% of the diameter**.
- On black: a soft glow under the arcs (two wider, low-opacity copies in react-native-svg; a blur filter on web).
- The number sits inside the ring (Outfit 900 at 30% of the diameter) with "OF 850" beneath; the capital legend reads
  under the ring (two dots, the capital in caps, the pair).
- No stored contributions (an older server): one ink arc of the score's share of 850. No score: the track alone.
- Sizes: 156 on the M.I.A. card (Home, Me), 132 on My Intelligence's dark score card, 96 default.

**Capital pairings — a PROPOSAL pending the athlete's confirmation**: Audience = audience scale · engagement quality;
Commercial = commercial proof · brand fit; Brand = narrative power · cultural relevance; Performance = athletic
authority · momentum.

The ring may sit on white or on black; the former "always on dark" rule is relaxed to a choice per screen.

---

## 11. Components (`client/components/ui`, `bold` variants)

### Button
A **pill**, **48 high**, 13/800 uppercase (§0 rule 8), 0 20 padding, press .98.

| Variant | Look |
|---------|------|
| primary | raspberry fill (`Bold.act`), white label — the ONE main action |
| secondary | black fill, white label — a strong action that is not the main one |
| small | 34 high, 1.5px black line, 11/800 — a secondary at small size |
| smallAct | 34 high, raspberry fill — a card's main action at small size (Your plan's next action) |
| onHero | white fill on a photo, 40 high |
| link | text 13/800 in ink with a 13px arrow-right (`LinkText`); white on black |

The legacy kit `Button` (no `bold`) fills with `C.primary` (= raspberry); `ghost` is the outline secondary. The Mila
cards' `MilaButton` follows the same rule: `primary` raspberry, `soft` grey, `quiet` text, `onDark` white.

### Chip
24 high, pill, 10/900 uppercase, 7 × 8 padding. Never tappable except Mila's `line` chips.

| Variant | Look | Use |
|---------|------|-----|
| light | white, ink text | categories on a photo |
| dark | black, white text | categories and roles on white ("Partner", "Captain") |
| line | white, 1.5px black line, 12/700 sentence case | status words ("Deferred", "NIL deal"), Mila's help chips |
| needs you (`blue` in code, historic) | raspberry tint, raspberry ink | ONLY when something waits on her: "Waiting for you", "3 waiting" |

### Card
White, 1px `line`, corner 16, no shadow (legacy `Card` keeps its soft shadow, at corner 16 too). Rows inside: 12 × 14 padding, 1px line between, chevron 18 quiet.

**The whole card is the target** (owner, 10 Oct 2026). A card or row that carries a link to open, review, expand or
"See more / See all / Open" opens on a tap ANYWHERE on it, not only on the link: the link is a cue, not the only target.
Press feedback (0.98, §7) is on the whole card; it is one accessible button named by its title. Explicit buttons for a
DISTINCT action keep their own target inside it (Send, Keep, Not now, Accept, Decline, Set) — and never a second way to do
what the card tap already does. A collapsed card expands the same way (§12c).
A **section card** (What Nomila Knows, My Intelligence) has an eyebrow head with a 2px black rule (`RuledHead`).

### Section head
17/900 uppercase + an optional blue link at the right; an optional 14/400 mute lede beneath (`SectionHead`).

### Photo card
Image full-bleed, the foot scrim from 38%, chips + the uppercase 800 title at the foot, corner 16.
Rail: **236 × 200**, the whole card opens the detail. Plan: **150 tall**, then under the card the "Advances your
{Domain} priority" caption and the Review link.

### Icon tile
40 square, corner 4, Feather 18: **black** (white glyph) for doors, help rows and marks; **grey** (ground, ink glyph)
for neutral domain tiles. 44 with glyph 22 for a header.

### Logo mark
White square, 1px line, corner 4, the real logo inset 72% (Yoku / favicon chain in `lib/brand-logo`); initials in
ink only as the fallback. Sizes 24 · 36–40 · 48.

### Her words
**One style for anything she said**: 16/600 in ink, a 3px blue rule at the left, a 10/800 uppercase blue label
("In your words", "You said", "From you"), an optional 12/500 source line. Nomila's text never takes it (`HerWords`).

### Avatar
Circle, 2px edge: white on a photo, ink on white. Fallback: her sport's Feather icon on the ground. 28 in the top bar.

### Input / Text field
48 high, pill (multi-line: corner 16), white or ground, 1px line; focus: 1.5px ink. Minimum 16px font on web.

### Modal / Sheet
Overlay `rgba(0,0,0,.5)`; sheets take 20 top corners and a grab handle. Buttons inside follow §11 Button.

### Shell
- **Top bar**: 52 high, 16 gutter. NOMILA wordmark (13/900, .34em) at left; the gear (20) and her avatar (28) at
  right. White over a hero's top scrim; ink on a white screen. Pushed screens replace the wordmark with ‹ and the
  PARENT's name in caps (11/800, .16em) — "‹ HOME", "‹ YOUR PLAN".
- **Bottom tab bar**: white, 1px line on top, five tabs, Feather 22 and a 10/700 label; active = ink, inactive =
  quiet, **no colour**. Mila is the centre button, lifted 26: a 50 circle showing **Mila's idle avatar** (her idle
  loop; idle only — no working/busy state). Soft per the Muse direction: no ring, no ink outline, only the overlay's
  very soft lift. She plays only while the app is foregrounded and Ask Mila is not the open tab (one Mila video at a
  time); otherwise, and under reduce motion, her still. The button announces "Ask Mila". Icons: home · compass · Mila
  · inbox · aperture. Height 49 + safe area. (Classic layout keeps its 50 black disc with ⚡.)
- **Top tabs** (Strategy): 12/800 uppercase, 18 apart, a 3px ink underline on the active one.
- **Pushed-screen bar** is ONE component (`ui/StackHeader` `bold`; `dark` for white over a deck or photo), inside the
  screen's SafeAreaView — never under the status bar. Decks pass it as `topBar`.
- **Pull to refresh** on every scrollable tab root and the opportunity detail: one ink spinner (`ui/PullRefresh`),
  refetching that screen's own queries. No refresh buttons.

---

## 12. Density: collapsed cards, decks and letters

Approved 5 Oct 2026 (the density pass). Three parts added to the system — the **deck** (full-bleed swipeable pages with
a counter), the **letter** (a white sheet over the deck's foot) and the **collapsed card** (a section that opens in
place) — and one rule.

### 12a. The rule

**The deck shows what it's about — images and facts about the subject. The letter shows what Nomila thinks and asks —
proposal, why, priority, action, decision. No text appears in both.**

So: the title, chips and identity line live on the deck; the proposal, why, priority, action and buttons live in the
letter. Nothing is said twice. No subject (a recommendation that names no brand): the deck is image-only — atmosphere (§9),
the category default when none is left. One image ⇒ a plain hero, no counter, no swipe.

**Deliberate exception: the Turn-on sheet's consent block** (owner, 5 Nov 2026). The sheet's second row ("You choose
what Mila can do: Nothing is posted without your tap…") and the consent block in its pinned foot ("Always asks you
first: Posting anything") say the same thing on purpose. The row is the sheet's plain explanation. The block is the
record of what a yes covers, in the registry's exact words (`consentWords`). Both stay. Nowhere else may two parts of a
screen repeat each other.

### 12b. When to use which

- **Collapsed card → expands in place** for a section of one screen: a list that is one of several (Knows sections), a
  passage with a summary line (Story sections). Head + one-line summary + count or thumbnails; never more than one open.
- **Deck + letter** for one thing she decides or asks about: a recommendation, a brand, a deal. The subject on top, what
  Nomila thinks and asks below. The card she tapped becomes page 1.
- **Plain list** when there are ≤ 3 rows and nothing to hide (At a glance, Brands & business with two partners, Mila's
  help rows). Collapsing two rows saves nothing and costs a tap.
- **No placeholder rows** for data that isn't connected (deal status, contract terms): the row does not exist until the
  data does.

### 12c. Expand (`ui/Accordion`)

- Spring, ~250 ms, no bounce past the final height; the chevron turns 180°; the opening card's head gets the 2px black
  rule.
- One open at a time per screen (`AccordionGroup`). Opening a second closes the first; the open card scrolls so its head
  sits under the top bar.
- Inside a section, row-level folds (See all N / Unconfirmed (n)) stay independent of the accordion.

### 12d. The deck (`ui/Deck`, `Bold.deck`)

- Full-bleed pages, **372** tall, no peek — the counter chip "n / N" (bottom-right, lifted 40 clear of the letter) is the
  only swipe affordance, and it exists only when there are **two or more** pages. Page 1 always exists; pages 2…N are
  built only from data that exists, in the order identity · about · athletes · audience · fit (BrandDeckHero) — per
  field that exists: a brand with images but no text research shows identity plus image-only pages; a brand with no
  images at all is a single hero.
- Pages show the subject: images, and facts about the brand. A "Fit for you" page is the three ratings (sport fit ·
  audience fit · diversification) and nothing else — the reasoning is the letter's Why this fits. Fit is drawn only
  where deal analysis supplies it; a brand opened from What Nomila Knows has none.
- Scrim 5% → 30% → 72% top to bottom. Brand facts sit on the panel (`DeckPanel`: solid black 66%, a 1px white 16%
  line, radius 6 — never a blur, §6) inset 14 and lifted clear of the letter; the counter sits at the panel's lower-right
  corner. Page 1 carries the identity line (`DeckIdentity`: logo · brand · category on ONE line) or the title instead of
  a panel. No image ⇒ the blank ground (§8a), never a tint.
- Tap anywhere on a page scrolls to the letter; swipe moves pages; the top bar rides over the deck.

### 12e. The letter (`ui/LetterSheet`, `LetterBlock`)

- White sheet, radius 6 on the top corners only, overlapping the deck by **24** px (so anything anchored to a page's foot
  clears it: panels and the counter sit at 40). It scrolls with the screen, inside the same scroll view, never a modal.
- Nomila's voice, calm, and never a line the deck already shows: a recommendation letter opens with the date ("Suggested
  27 Sep 2026"), then the full proposal, then hairline-divided blocks — Why this fits · Advances your … priority · What
  Nomila would do — then the decision. A brand letter is headed "Adidas and you" and holds what Nomila knows about her
  and the brand (each fact with its tier, source and date), what she told Nomila, what it heard but has not confirmed,
  and the contract request when one exists. Her words appear only when she said them (the blue rule, §11 Her words).
- Decision buttons never fold: Accept (black) / Not now · Decline (outlined) and the safety line are always rendered.
  Only the sources and the not-seen list collapse.

### 12f. Accessibility

- The accordion head is a button with `accessibilityState.expanded`; it announces "<title>, N items". The counter is a
  polite live region and reads "Page n of N".
- Pages are focusable in order; the letter's first line (the date, or the brand heading) is a header, the next focus stop
  after the deck. Minimum targets stay 44 px; the counter chip is not a target.
- Reduced motion: expand becomes a 120 ms fade; the deck still swipes.

### 12g. Always expanded

- Decision buttons and the safety line on a recommendation; the identity page of any deck; At a glance on Knows; the
  hero statement on Story.
- A collapsed card never hides a state that needs her: "Waiting for you" shows on the collapsed card itself.

---

## 13. Iconography

Two tiers (owner decision, 20 Oct 2026, "Icons and Glass"):

**Illustrations — the few doors that carry character**: Me's tiles, Studio's Create menu (Post · Ad · Deck · Page) and
empty states ("Nothing waiting on you", no bookings, an empty Studio). Never on work screens' controls — Opportunities'
Deals / Bookings toggle is text pills with a pink count (owner, 20 Oct 2026). Small ones (Create, empty states, 72–120)
are one simplified object, a bold silhouette that reads at 32px. Soft, matte 3D objects in one shared camera
(three-quarter, from slightly above), one soft studio light, a soft contact shadow, on pure white so they sit on the
white tile; ring colours only as small accents; never clay or cartoon proportions, never people. Two kinds:
- **Fixed** — one picture for every athlete (Offers, Bookings, Shop): `client/assets/illustrations/`.
- **Her content on a frame** — a one-time empty frame (a book, a stack of prints, a page, a rate card) with HER photos,
  name and numbers laid onto its flat faces in code (`lib/meTilesLogic`, `components/me/ComposedTile`), then flattened
  to one picture. Text is real text, so it is always her actual numbers. Never generated per athlete.
Tile: white, radius 20, the soft wide card shadow, no border; the picture fills the tile; the label centred under it,
no subtitle; a pink count only when something needs her; an odd last tile runs full width. Shipped files carry no
metadata, and nothing that ships (names, comments, alt text) describes how a picture was made; alt text is the label.

**Line icons — everything small and functional**: Feather (`@expo/vector-icons` native, `lucide-react` web). The tab
bar, back, close, chevrons, settings-style rows (Me's Get set up / Connections and What Nomila knows). Sizes 14–16
inline, 18 in tiles, 20 in the bar and rows, 22 in tabs and category defaults. Colour inherits: ink on white, white on
black and photos, quiet for chevrons, blue only for a link's arrow. Never emoji as icons.

---

## 14. Platform-Specific Rules

### Native (iOS + Android)
- **Touch targets**: minimum 44×44 (hit-slop where the visual is smaller — chips, the back label, links).
- **Safe areas**: `useSafeAreaInsets()`; never hard-code top/bottom padding. Heroes draw the bar inside the safe area.
- **Haptics**: light tap → `ImpactFeedbackStyle.Light`; confirm → `NotificationFeedbackType.Success`; error → `Error`.
- **Fonts**: load every Outfit weight via `useFonts()`; show nothing until loaded (`SplashScreen.preventAutoHideAsync()`).
- **Status bar**: light content over a photo hero.
- iOS swipe-back unless a modal needs it off; Android hardware back and `android_ripple`.

### Web Desktop
- `cursor: pointer` and a visible `:focus-visible` ring (`2px solid #2D6BFF`, offset 2) on every interactive element.
- Breakpoints 375 · 768 · 1024 · 1280; max content width 1200, centred.
- **The app in a browser** (`WebFrame`, owner 26 Oct 2026): from 768 wide, the app keeps its 480 phone column, corner
  24, a soft lift (no bezel), 24 margin top and bottom, over nomila.co's own hero photos (the landing's set, placement
  and 40 s cross-fade) blurred 14 under a light scrim (about half the landing's, a shade under the wordmark for ≥ 4.5:1), the landing's NOMILA wordmark top left in white (from 880,
  where it clears the column). The one sanctioned background blur (§6). Reduced motion: one photo. Under 768: the app
  fills the window, no frame.

### Mobile Web
- `viewport-fit=cover`, 44×44 targets, no hover-only interactions, `-webkit-tap-highlight-color: transparent`.

---

## 15. Do's and Don'ts

| Do ✅ | Don't ❌ |
|-------|---------|
| ONE raspberry pill for the main action per screen or card; grey / outline pills for the rest | A black main action, two raspberries on one card, or the ring pink `#E84591` (any ring colour) as a UI colour |
| Run imagery full-bleed under the scrim with uppercase 900 type (§9 decides whose) | Use the dark "aurora" hero or a cream ground |
| White cards at 16 with a 1px line OR a soft shadow | A border-and-shadow stack, gradients on surfaces |
| Pill buttons and chips, 16 cards, 20 sheets | Sharp 4/6 corners on new UI, a dark mode the owner has not asked for |
| Keep the M.I.A. card dark everywhere | A white M.I.A. score card |
| Set her words in `herWords` behind the blue rule | Put Nomila's text in the her-words style |
| Draw the ring from stored contributions, two tones per capital | Recompute bands from scores, or colour anything else with ring colours |
| Spread a `BoldType` role on every Text | Type a `fontSize` or `fontFamily` in a screen |
| Her photos only where the content is about her (face ≤ 2 per screen); atmosphere everywhere else | Fill every card with her photos; people, logos or text in an atmosphere image; an atmosphere image without its credit line |
| Category defaults: black ground, outlined word, one blue mark | Saturated fills, a brand the record does not name |

---

## 16. Chat Interface

Unchanged from the previous spec: the `Chat` tokens in `client/constants/theme.ts` govern every agent chat screen
(agent 24/34 heading, user bubbles 18 with a 4 top-right corner, list padding 24 × 16, input radius 22). Migration of
chat is on the one look through the `N` tokens (white grounds, raspberry primary).

**Mila cards v2 (design "Mila card designs" v2.2, approved 3 Nov 2026; `client/components/mila/cards/kit`, behind
EXPO_PUBLIC_MILA_CARDS_V2).** One card per type, in two densities: **collapsed** (the same card the app screen shows:
an image or logo, one bold headline, at most two buttons) and **expanded** (the line, figures, sources and the second
action). In chat a tap on the body expands it in place (one open at a time); on an app screen it opens the detail
screen; the primary button always acts directly (Turn-on's sheet is the one exception: the consent is the sheet). That sheet's
body (mark, name, purpose, the three rows) scrolls; its foot is pinned: the consent block (`Bold.ground`, corner 16; the
registry's `reads` under "Once it's on, Mila will" with a check, its `alwaysAsks` under "Always asks you first" with a
lock, verbatim and never cut, an empty group not drawn), the legal line, the raspberry Turn on and a text-link Not now.
At most 2 + 2 consent lines (`TURN_ON_CONSENT_MAX`), so the foot stays near 60% of a 375×667 phone. The
surface is paper, corner 18, no border, with the **card lift** `0 1 2 / .06 + 0 12 32 / .11` (`CARD_LIFT`; Android keeps
the hairline). Media first, clipped to the top corners, in named sizes (band 132 · band-sm 96 · thumb 4:5 · row tile
58×70 · logo 40/56), with a frosted kind chip top-left. Type inside a card: `BoldType.cardHeadline` 17/800 ·
`cardLine` 14/500 · `cardMeta` 12/500. At most one raspberry primary; Ask Mila is Mila's frosted pill with her 26 still.
The server picks every image (§9 order) and the schema caps the words (headline ≤ 48, line ≤ 90). At most two faces
on one screen across cards. After a tap a card becomes a receipt (ink tick 22 + a past-tense line).

**Deliberate exception — the Ask Mila overlay (owner direction, 8 Oct 2026: "much like Muse").** The Mila surfaces
(`client/screens/MilaSearchOverlay.tsx`, `client/components/mila/MilaHeader.tsx`, `client/components/mila/Frost.tsx`)
do not follow look B's square corners / outlined words / no-shadow rules; they follow the Muse reference instead:

- Her avatar floats at top-centre over the transcript: a plain circle, **no ring, no dark edge**, only a very soft
  diffuse lift (iOS/web; none on Android, whose elevation draws a hard grey ring). 96 on the empty state and while
  voice is live, 64 in a typed conversation.
- Under it, a **frosted-glass rounded label** (`Frost`: expo-blur `BlurView` + thin white wash, no border): "Mila"
  alone when idle; two lines while she works — "Mila", then the status ("Generating…", "Speaking"…) in a lighter
  weight.
- The transcript scrolls **under** the header, blurred and washed in translucent white that fades to clear.
- **Ask Mila is the centre tab's own screen**: the bottom menu stays under the chat, and switching tabs is how she
  leaves (no close). While the keyboard is up there the bar steps aside; put away, it returns.
- The top controls follow Muse: **one** round frosted menu at the left (Saved chats · New chat · Delete this chat, in
  a small frosted popover), her avatar and name in the middle, **one** action at the right (new chat). No title.
  **Frosted-glass circles** of the same treatment, 40 visible with a ≥ 44pt touch target; **no ink outlines** anywhere
  on these surfaces, no pink gradients on them.
- **Keyboard and scrolling (Muse)**: a tap on the transcript or a drag puts the keyboard away (iOS follows the
  finger), and so does sending; the composer sits directly on the keyboard while typing and above the tab bar
  otherwise. A conversation is bottom-anchored just above the composer and follows the reply as it streams — unless
  she has scrolled up to read, until she sends or scrolls back down.
- The small still beside each "Mila" message label has no ring either.
- **The composer** is a frosted bar (corner 26) floating over the white ground — no ground or rule behind it, no border. ＋
  and an empty send are frosted 38 circles; a ready send (and the mic while voice is on) is a solid white circle
  with the soft lift and an ink glyph. **No dark discs, no pink gradients.**
- **Live voice** replaces the composer with a frosted bar of the same corner: a blue live dot (the "Active" accent),
  the header's own status words (`milaActivity`: "Joining…", "Listening", "Speaking") and a white lifted "End
  voice" button. "Mic off" is a small frosted banner.
- **Cards in the chat** (goal, pick, reply, first-look, profile-update, the error fallback) and the saved-chats rows
  share one surface (`mila/milaSurface.ts`): white, corner 18, the soft lift (`mila/softLift.ts`), no border
  (a hairline `line` on Android only, which gets no lift). Source and search chips are the same, smaller.
- **Openers, follow-ups and nav chips** are frosted rows / chips (corner 18 / 17), ink text, quiet grey glyphs;
  openers lead with her still. The ＋ sheet is a frosted sheet floating 10 off the edges over a light dim, its
  tiles Mila cards; the saved-chats close button is the overlay's frosted circle.
- **Home**: the "Mila can help with…" heading leads with her still (18, no ring), not a bolt.
- **The onboarding head (Mila's intro only, owner-approved Option B, 12 Oct 2026).** On the intro screen
  (`client/screens/onboarding/MilaIntroScreen.tsx`) she sits at the top **left**, not top-centre, so every choice
  and the button fit on the first screen: the avatar at 48 (idle, no ring), beside it a two-line frosted label
  ("Mila", then "Your agent" in the lighter caption weight, so her name shows once), and at the right one frosted
  40 circle ("i", ≥ 44 target) that opens "How it works". A dark status bar over the white ground. A picked tile takes
  the sport grid's raspberry tint and line; "Let's start" is the raspberry pill. Everywhere else her
  avatar stays top-centre as above.

---

## 17. Files to Keep in Sync

| File | Role |
|------|------|
| `DESIGN.md` | This file — the spec |
| `client/constants/theme.ts` | `Bold` (incl. `Bold.deck`), `BoldType` (look B) · `Colors`, `Typography`, `Type`, `Tint`, `BorderRadius`, `Shadows` (legacy) |
| `client/constants/ring.ts` | The ring: dimension → capital, the two tones per capital, gap, stroke |
| `client/components/ui/*` | The kit: `bold` variants of Card, Row, Chip, Button, IconTile, LogoMark, StackHeader; `ui/Bold.tsx` for SectionHead, Eyebrow, LinkText, HerWords, RuledHead |
| `client/components/ui/Deck.tsx`, `LetterSheet.tsx`, `Accordion.tsx` | The density pass (§12): the deck (+ DeckPanel, DeckIdentity, DeckChip), the letter (+ LetterBlock), the collapsed card (+ AccordionGroup) |
| `client/components/intelligence/IntelligenceRing.tsx` | The ring and its legend |
| `client/components/strategy/RecommendationVisual.tsx` | The photo card image and the category defaults |
| `client/components/shell/TopBar.tsx`, `TabBar.tsx` | The shell |
| `client/constants/outfitOnly.test.ts`, `boldOnly.test.ts` | Source scans that keep the surfaces on this spec |
| `assets/logo-mark.svg` | Logo mark — the ring colours' source of truth |

---

## 18. Superseded

Retired by the one look on 22–23 Oct 2026:

- **Look B's sharp corners** (0 / 3 / 4 / 6), its rectangular buttons and its "pills are retired" rule.
- **The one electric blue** (`#2D6BFF`) as accent and the **black main action**: links read in ink, "needs you" takes
  the raspberry tint, the main action is raspberry.
- **Dark mode** following the phone (`useLook()` and the `Colors[scheme]` screens): light only for now.
- **The legacy `Colors.light` values** (cream grounds, warm greys, pink primary, blue link) — the tokens remain, their
  values are the one look's.

Retired by look B on 5 Oct 2026 and **not to be used anywhere**:

- **Pink as the action colour** (`#E84591` primary buttons, active tab, links, tinted chips) and the tinted chip
  variants (primary / blue / gold / success); the `Tint` pairs (said / found / made / proof / stage).
- **Cream surfaces** (`#FAF8F5` screen, `#F5F0EB` input, `#E8E2DB` border) and the **dark aurora hero** (`#0D0B08`
  with the blue/pink radial glow) — including the "rings always on dark" rule and the ghost guide circles.
- **Round corners** (10 / 14 / 20 / 28 / 36 and pill buttons), card shadows, the brand gradients.
- The **four concentric arcs** score widget (`ConcentricRingScore`) as the M.I.A. visual, and the single pink → teal
  eight-band ramp.
- The 800-topped type scale (display 32/800, h1 26/700…) as `Type` / `Typography`.

Legacy screens (the Studio create path, the email thread, Settings, Pitches, the Brand tab, the Classic layout) still
read `Colors`, `Type`, `Tint`, `BorderRadius` and `Shadows` by name; those names now carry the one look's values, so the
screens render white with raspberry actions. They still migrate screen by screen to the kit's `bold` variants and the
`Bold` / `BoldType` tokens (their headers, type scale and layouts are the older design).
