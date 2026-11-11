/**
 * studio/imageOps — PR 19's sentence-door readers (docs/probes/image-ops.md; ADI-R19). Pure, $0, deterministic.
 *
 * Each reader is a CLOSED, WHOLE-SENTENCE shape: it answers for her entire sentence or for none of it, so it can
 * never steal part of a sentence another rule reads. `route` (studio/classify.ts) calls them only with
 * STUDIO_IMAGE_OPS on and a photo to edit; off, nothing here runs and every answer is today's.
 *
 *   readPose         a pose, an action or an expression → GENERATE (R-8: pose is never an op; her approval of the
 *                    new image is the spend gate). Expression edits are treated as pose (R-8 (i)).
 *   readRelight      a lighting change → RELIGHT, one of the style vocabulary's lighting members.
 *   readCamera       a camera angle → CAMERA (R-13): low, high or overhead. A shot SIZE is not here: tighter is a
 *                    crop, and wider is extend, which is faded.
 *   readWeather      weather → a background change, "same place in <weather>" (R-9).
 *   readLookPointer  "match this look", "same vibe as the second one" → the attached style reference's look (B).
 *   readVague        "make it pop", "make it better" → the `vague` ask with op chips (R-6).
 *   normalizeWords   closed typo and slang maps (R-7), applied before any rule reads her words.
 *
 * ⚠️ THE MEMBER LISTS BELOW ARE THE STYLE VOCABULARY'S, COPIED ON PURPOSE. This module is imported by
 * studio/classify.ts, so it imports nothing at runtime; imageOps.test.ts pins LIGHT_MEMBERS to compile/style.ts's
 * LIGHTING_PHRASES and CAMERA_ANGLES to its CAMERA_PHRASES, so the copies cannot drift.
 */

/** The lighting members a RELIGHT names: compile/style.ts's LightingMember, all of them (pinned by test). */
export const LIGHT_MEMBERS = [
  "natural",
  "golden_hour",
  "studio",
  "hard_light",
  "soft_light",
  "rim_light",
  "backlight",
  "neon",
  "stadium",
  "low_key",
  "high_key",
] as const;
export type LightMember = (typeof LIGHT_MEMBERS)[number];

/** The camera members a CAMERA edit names: the three ANGLES of compile/style.ts's CameraMember (R-13). */
export const CAMERA_ANGLES = ["low_angle", "high_angle", "overhead"] as const;
export type CameraAngle = (typeof CAMERA_ANGLES)[number];

/** Her sentence as the readers compare it: lowercase, one space, no leading courtesy, no closing punctuation. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/^(please|pls|can you|could you)\s+/, "")
    .replace(/\s+please$/, "")
    .trim();
}

// ─── Pose → GENERATE (R-8) ──────────────────────────────────────────────────────────────────────────────

const ACTIONS =
  "jump|jumping|run|running|sprint|sprinting|kick|kicking|dunk|dunking|sit|sitting|sit down|stand|standing|" +
  "stand up|kneel|kneeling|squat|squatting|crouch|crouching|celebrate|celebrating|dance|dancing|flex|flexing|" +
  "wave|waving|point|pointing|turn around|spin|lean|leaning|pose|posing|stretch|stretching|throw|throwing|" +
  "catch|catching|shoot|shooting";
const EXPRESSIONS =
  "smile|smiling|laugh|laughing|frown|frowning|wink|winking|grin|grinning|cry|crying|shout|shouting|look happy|look serious|look angry";
const GAZE =
  "look (?:left|right|up|down|away|straight ahead|to the left|to the right|at the camera|over my shoulder)|" +
  "face (?:the camera|left|right|forward|away|the other way)";
const BODY_PARTS =
  "arm|arms|hand|hands|leg|legs|fist|fists|knee|knees|head|chin";

const POSE: readonly RegExp[] = [
  new RegExp(
    `^(?:make|have|get) me (?:${ACTIONS}|${EXPRESSIONS}|${GAZE})\\b(?! like\\b)`,
  ),
  new RegExp(
    `^(?:raise|lift|lower|put up|drop|cross|bend|tilt) my (?:${BODY_PARTS})\\b`,
  ),
  new RegExp(
    `^put my (?:${BODY_PARTS}) (?:up|down|on my hips|behind my head|in the air)\\b`,
  ),
  /^(?:change|switch|fix) (?:my|the) (?:pose|stance|posture|expression|facial expression)\b/,
  /^(?:give me|try) (?:a )?(?:new|different|another) (?:pose|stance|expression)\b/,
  /^(?:a )?(?:new|different) pose\b/,
  /^turn me (?:around|to the (?:left|right)|sideways)\b/,
  new RegExp(`^(?:${EXPRESSIONS})$`),
];

/** Does her sentence ask to change how she is posed, what she is doing, or her expression? */
export function readPose(text: string): boolean {
  const s = plain(text);
  return POSE.some((re) => re.test(s));
}

// ─── Lighting → RELIGHT ─────────────────────────────────────────────────────────────────────────────────

/** Her lighting word → the member. Longest first, so "golden hour" is read before any shorter word. */
const LIGHT_WORDS: readonly (readonly [string, LightMember])[] = [
  ["golden hour", "golden_hour"],
  ["natural light", "natural"],
  ["low key", "low_key"],
  ["low-key", "low_key"],
  ["high key", "high_key"],
  ["high-key", "high_key"],
  ["rim light", "rim_light"],
  ["floodlights", "stadium"],
  ["floodlight", "stadium"],
  ["backlight", "backlight"],
  ["backlit", "backlight"],
  ["sunset", "golden_hour"],
  ["sunrise", "golden_hour"],
  ["studio", "studio"],
  ["stadium", "stadium"],
  ["natural", "natural"],
  ["daylight", "natural"],
  ["diffused", "soft_light"],
  ["soft", "soft_light"],
  ["harsh", "hard_light"],
  ["hard", "hard_light"],
  ["neon", "neon"],
  ["back", "backlight"],
  ["rim", "rim_light"],
];
const LIGHT_ALT = LIGHT_WORDS.map(([w]) => w.replace(/-/g, "\\-")).join("|");
const LIGHT_NOUN = "(?:lighting|light|lights)";

const RELIGHT: readonly RegExp[] = [
  new RegExp(
    `^change the (?:lighting|light) to (?:an? )?(${LIGHT_ALT})(?: ${LIGHT_NOUN})?$`,
  ),
  new RegExp(
    `^(?:add|use|give it|put) (?:an? |some )?(${LIGHT_ALT}) ${LIGHT_NOUN}$`,
  ),
  new RegExp(
    `^relight (?:it |this |me |the photo |the picture )?(?:with|in|using|as|under) (?:an? |some )?(${LIGHT_ALT})(?: ${LIGHT_NOUN})?$`,
  ),
  new RegExp(
    `^make (?:it|the lighting|the light) (?:an? )?(${LIGHT_ALT}) ${LIGHT_NOUN}$`,
  ),
  new RegExp(
    `^light (?:it|me|this) (?:with|like|using) (?:an? |some )?(${LIGHT_ALT})(?: ${LIGHT_NOUN})?$`,
  ),
];

/** The lighting member her sentence asks for, or null. It must SAY lighting — "make it golden hour" stays a look. */
export function readRelight(text: string): LightMember | null {
  const s = plain(text);
  for (const re of RELIGHT) {
    const m = re.exec(s);
    if (m) return LIGHT_WORDS.find(([w]) => w === m[1])?.[1] ?? null;
  }
  return null;
}

// ─── Camera → CAMERA (R-13) ─────────────────────────────────────────────────────────────────────────────

/** Her angle words → the member. Overhead is read before "from above", which is a high angle. */
const ANGLE_WORDS: readonly (readonly [string, CameraAngle])[] = [
  ["from directly above", "overhead"],
  ["directly overhead", "overhead"],
  ["overhead", "overhead"],
  ["bird's eye", "overhead"],
  ["birds eye", "overhead"],
  ["top down", "overhead"],
  ["top-down", "overhead"],
  ["from a low angle", "low_angle"],
  ["low angle", "low_angle"],
  ["low-angle", "low_angle"],
  ["from below", "low_angle"],
  ["worm's eye", "low_angle"],
  ["worms eye", "low_angle"],
  ["from a high angle", "high_angle"],
  ["high angle", "high_angle"],
  ["high-angle", "high_angle"],
  ["from above", "high_angle"],
];
const ANGLE_ALT = ANGLE_WORDS.map(([w]) => w.replace(/-/g, "\\-")).join("|");
const SHOT = "(?: shot| view| photo| angle| perspective)?";

const CAMERA: readonly RegExp[] = [
  new RegExp(
    `^(?:make|turn) (?:it|this)(?: into)? (?:an? )?(${ANGLE_ALT})${SHOT}$`,
  ),
  new RegExp(
    `^(?:shoot|show|photograph|take|see) (?:it|this|me|the photo) (?:from )?(${ANGLE_ALT})${SHOT}$`,
  ),
  new RegExp(
    `^change the (?:camera )?(?:angle|view|perspective)(?: to)? (?:an? )?(${ANGLE_ALT})${SHOT}$`,
  ),
  new RegExp(`^(?:use|try) (?:an? )?(${ANGLE_ALT})${SHOT}$`),
  // W-5 (ADI-R19-W): the walk's bare forms — "from above", "bird's eye view", "shot from below", "a low angle shot".
  new RegExp(`^(?:an? )?(${ANGLE_ALT})${SHOT}$`),
  new RegExp(`^(?:shot|shoot|taken) (${ANGLE_ALT})${SHOT}$`),
];

/** The camera angle her sentence asks for, or null. */
export function readCamera(text: string): CameraAngle | null {
  const s = plain(text);
  for (const re of CAMERA) {
    const m = re.exec(s);
    if (m) return ANGLE_WORDS.find(([w]) => w === m[1])?.[1] ?? null;
  }
  return null;
}

// ─── Weather → a background (R-9) ───────────────────────────────────────────────────────────────────────

/** Her weather word → the setting, "same place in <weather>". Every value is inside rule 2's 40 characters. */
const WEATHER: ReadonlyMap<string, string> = new Map([
  ["rain", "same place in the rain"],
  ["rainy", "same place in the rain"],
  ["raining", "same place in the rain"],
  ["snow", "same place in the snow"],
  ["snowy", "same place in the snow"],
  ["snowing", "same place in the snow"],
  ["sunny", "same place on a sunny day"],
  ["cloudy", "same place on a cloudy day"],
  ["overcast", "same place on a cloudy day"],
  ["fog", "same place in the fog"],
  ["foggy", "same place in the fog"],
  ["misty", "same place in the fog"],
  ["storm", "same place in a storm"],
  ["stormy", "same place in a storm"],
]);
const WEATHER_ALT = [...WEATHER.keys()].join("|");

const WEATHER_SHAPES: readonly RegExp[] = [
  new RegExp(
    `^make (?:it|the weather|the day|the sky) (?:an? )?(${WEATHER_ALT})(?: day| weather| out| outside)?$`,
  ),
  new RegExp(`^make it look like it(?:'s| is) (${WEATHER_ALT})$`),
  new RegExp(
    `^change the weather to (?:an? )?(${WEATHER_ALT})(?: day| weather)?$`,
  ),
  new RegExp(`^(?:add|put) (?:some )?(rain|snow|fog)$`),
];

/** The background her weather asks for — "same place in the rain" — or null. */
export function readWeather(text: string): string | null {
  const s = plain(text);
  for (const re of WEATHER_SHAPES) {
    const m = re.exec(s);
    if (m) return WEATHER.get(m[1]) ?? null;
  }
  return null;
}

// ─── The look pointer (B) ───────────────────────────────────────────────────────────────────────────────

/** The look a pointer compiles as: the canonical look term the style reference's spec-driven arm replaces. */
export const POINTED_LOOK = "colour grade";

const ORDINAL = "(?:second|first|other|last|third|2nd|1st|3rd)";
const IMAGE_NOUN = "(?:one|photo|picture|pic|image|shot)";
const PTR = `(?:this|that|the ${ORDINAL}(?: ${IMAGE_NOUN})?|th(?:is|at) ${IMAGE_NOUN}|the ${IMAGE_NOUN} i (?:attached|added|picked))`;
const LOOK_NOUN = "(?:look|style|vibe|vibes|aesthetic|feel|mood)";

const LOOK_POINTER: readonly RegExp[] = [
  new RegExp(`^match (?:this|that|the) ${LOOK_NOUN}$`),
  new RegExp(`^match the ${LOOK_NOUN} of ${PTR}$`),
  new RegExp(`^match ${PTR}$`),
  new RegExp(`^(?:in|with) (?:this|that|the same) ${LOOK_NOUN}$`),
  new RegExp(`^(?:the )?same ${LOOK_NOUN} as ${PTR}$`),
  new RegExp(`^(?:give it|make it) the same ${LOOK_NOUN} as ${PTR}$`),
  new RegExp(
    `^make (?:it|this|this (?:picture|photo|pic|image)) (?:look like|match the ${LOOK_NOUN} of|match) ${PTR}$`,
  ),
];

/** Does her sentence point at another picture's look — "match this look", "same vibe as the second one"? */
export function readLookPointer(text: string): boolean {
  const s = plain(text);
  return LOOK_POINTER.some((re) => re.test(s));
}

// ─── Vague → the `vague` ask (R-6) ──────────────────────────────────────────────────────────────────────

const VAGUE: readonly RegExp[] = [
  /^make (?:it|this|the photo|the picture) (?:look )?(?:better|nicer|nice|good|great|amazing|awesome|fire|pop|hit|hit different|more professional|professional|pro|production quality|clean|cleaner|perfect)$/,
  /^make (?:it|this) pop(?: more)?$/,
  /^(?:clean it up|clean this up|fix it|fix this|improve it|improve this|enhance it|enhance this|touch it up|spruce it up|level it up|glow it up)$/,
];

/** Does her sentence ask for "better" without saying what should change? */
export function readVague(text: string): boolean {
  const s = plain(text);
  return VAGUE.some((re) => re.test(s));
}

/**
 * The op chips a vague ask offers — each one a sentence the rules read as a change on its own (imageOps.test pins
 * that every one routes with the flag on). Tapping one fills her draft; nothing is sent or spent until she does.
 */
export const VAGUE_SUGGESTIONS: readonly string[] = [
  "make it brighter",
  "make it more vibrant",
  "blur the background",
  "add studio lighting",
];

// ─── Typos and slang (R-7) ──────────────────────────────────────────────────────────────────────────────

/**
 * Closed maps, whole words only. A typo map is a list of misspellings seen or plainly likely, never an edit
 * distance: "rd" is red, but a distance rule would also make "rod" red. Slang maps to the word the rules and the
 * detector know. "shades" is NOT here: objectVocab keeps it out of the worn items on purpose.
 */
const TYPOS: ReadonlyMap<string, string> = new Map([
  ["jersy", "jersey"],
  ["jersie", "jersey"],
  ["jersye", "jersey"],
  ["shrit", "shirt"],
  ["shoos", "shoes"],
  ["sunglases", "sunglasses"],
  ["backround", "background"],
  ["backgroud", "background"],
  ["backgorund", "background"],
  ["remvoe", "remove"],
  ["rd", "red"],
  ["blu", "blue"],
  ["bleu", "blue"],
  ["gren", "green"],
  ["grean", "green"],
  ["blak", "black"],
  ["blakc", "black"],
  ["whte", "white"],
  ["wite", "white"],
  ["yelow", "yellow"],
  ["purpel", "purple"],
  ["ornage", "orange"],
  ["pnk", "pink"],
]);
const SLANG: ReadonlyMap<string, string> = new Map([
  ["kicks", "shoes"],
  ["trainers", "shoes"],
  ["drip", "outfit"],
  ["threads", "outfit"],
]);

/** Her words with the closed typo and slang maps applied, whole words only; everything else byte-for-byte. */
export function normalizeWords(text: string): string {
  return text.replace(/[A-Za-z]+/g, (w) => {
    const lower = w.toLowerCase();
    const to = TYPOS.get(lower) ?? SLANG.get(lower);
    return to && to !== lower ? to : w;
  });
}

// ─── The misroutes (R-25) ───────────────────────────────────────────────────────────────────────────────

/**
 * Words she QUOTED after an add verb — "add 'shop now' at the bottom" — are display text, not a thing to draw, and
 * display text beyond the ad's own headline is faded (ADI-R19-FADE). So it asks, instead of drawing an object
 * called "shop now". A quote opens after a space (or the start) and closes before a space or the end, so an
 * apostrophe inside a word ("don't", "it's") never reads as one.
 */
const QUOTED = /(?:^|\s)["“'‘]([^"“”'‘’]{1,60})["”'’](?=\s|$|[.,!?])/;
const ADDS = /\b(?:add|put|place|stick|write|type)\b/i;
export function readsQuotedAdd(text: string): boolean {
  return ADDS.test(text) && QUOTED.test(text);
}

/**
 * "put me in the middle of the frame" is a REFRAME — her position in the picture — not a place to put her. Rule 2
 * read it as a background "middle of the frame". A shift is extend-like and out (R-11), so it asks.
 */
const FRAME_PLACE =
  /\b(?:put|place|move|shift)\s+(?:me|her|him|them|us)\s+(?:in|at|on|to|into)\s+(?:the\s+)?(?:middle|center|centre|left|right|top|bottom|edge|corner|side)\b.*\b(?:frame|photo|picture|shot|image|pic)\b/i;
export function readsFramePlace(text: string): boolean {
  return FRAME_PLACE.test(text);
}

// ─── An ad of her photo (ADI-R19-W3) ──────────────────────────────────────────────────────────────────────

/**
 * The interpreter's AD_WORDS (interpret/menu.ts), copied: menu.ts imports classify, so classify cannot import it back.
 * Pinned equal to the original in imageOps.test ("the ad words are the interpreter's own").
 */
export const AD_WORDS_COPY =
  /\b(ad|ads|advert|adverts|advertisement|advertisements|campaign|campaigns|commercial|commercials)\b/i;

/** Does her sentence ask for an ad, in the interpreter's own words? */
export const asksForAd = (text: string): boolean => AD_WORDS_COPY.test(text);

/**
 * The brand's logo as a watermark (ADI-R19-W3's logo rec): "add the adidas logo as a watermark" — the one clause the
 * ad treatment writes for it (interpret/canonical.ts). The name as written; classify.ts keeps it only when it is a
 * brand the rules list.
 */
const BRAND_MARK_CLAUSE =
  /^add (?:the )?([a-z][a-z0-9 &'.-]*?) logo as a watermark$/;
export function readBrandMark(text: string): string | null {
  return BRAND_MARK_CLAUSE.exec(plain(text))?.[1] ?? null;
}

// ─── A crop (S-7; R-10: reformat = crop only; R-11: a tighter reframe is a crop) ─────────────────────────

/** What a CROP change names: an aspect she can post at, or `zoom` — a tighter window at the photo's own shape. */
export const CROP_VALUES = ["9:16", "4:5", "1:1", "zoom"] as const;
export type CropValue = (typeof CROP_VALUES)[number];

/** Her aspect words → the value. Wider than the photo is not here: that is extend, which is faded. */
const ASPECT_WORDS: readonly (readonly [RegExp, CropValue])[] = [
  [
    /^9 ?[:x/] ?16$|^(?:vertical|portrait|a story|stories|story|reels?|a reel|tiktok|for stories|for (?:a |my )?(?:story|reel|tiktok))$/,
    "9:16",
  ],
  [/^4 ?[:x/] ?5$|^(?:a post|for (?:a |my )?(?:post|feed|instagram))$/, "4:5"],
  [/^1 ?[:x/] ?1$|^(?:square|a square)$/, "1:1"],
];
const valueOf = (words: string): CropValue | null =>
  ASPECT_WORDS.find(([re]) => re.test(words))?.[1] ?? null;

const CROP_SHAPES: readonly RegExp[] = [
  /^crop (?:it|this|the photo|the picture|the image)?\s*(?:to|into|as|for)?\s*(?:a |an )?(.+?)(?: crop| format| shape)?$/,
  /^(?:make|turn) (?:it|this)(?: into)? (?:a |an )?(\d+ ?[:x/] ?\d+|square)(?: crop| format)?$/,
  /^(?:reformat|resize) (?:it |this )?(?:to|for|as|into) (?:a |an )?(.+)$/,
];
const ZOOM_IN =
  /^(?:zoom in|crop in|crop closer|zoom closer)(?: (?:on|to|closer to) (?:me|her|the person|the subject))?$|^crop (?:in )?(?:on|closer to) (?:me|her)$/;

/** The crop her sentence asks for, or null. "zoom out" is not one: wider than the photo is extend, faded. */
export function readCrop(text: string): CropValue | null {
  const s = plain(text);
  if (ZOOM_IN.test(s)) return "zoom";
  for (const re of CROP_SHAPES) {
    const m = re.exec(s);
    if (m) {
      const v = valueOf(m[1].trim());
      if (v) return v;
    }
  }
  return null;
}

// ─── Text on the photo (W-3, ADI-R19-W) ──────────────────────────────────────────────────────────────────

export type TextPlacement = "top" | "bottom" | "middle";

/** One quoted run of her words — straight or curly, single or double. */
const QUOTE_OPEN = `["“'‘]`;
const QUOTE_CLOSE = `["”'’]`;
const TEXT_ADD = new RegExp(
  `^(?:please\\s+)?(?:add|put|write|type|place)\\s+(?:the\\s+(?:text|words|headline|caption|line)\\s+)?${QUOTE_OPEN}([^"“”'‘’]{1,60})${QUOTE_CLOSE}` +
    `(?:\\s+(?:at|across|on|along|to|in)\\s+the\\s+(top|bottom|middle|center|centre)(?:\\s+of\\s+(?:the|this|my)\\s+(?:photo|picture|image|pic))?)?\\s*[.!]?$`,
  "i",
);

/**
 * Her quoted words as text on the photo, and where (W-3): "add 'shop now' at the bottom", "put "GAME DAY" in the middle".
 * One clause only — a compound ("…, and change the background") is rule ½'s to split — and never rule ⅛'s exact shape
 * (`add the headline "X" across the top`), which keeps its own path and bytes. The words are hers, verbatim.
 */
export function readTextAdd(
  text: string,
): { words: string; placement: TextPlacement } | null {
  if (
    /^\s*add\s+the\s+headline\s+["“][^"“”]*["”]\s+across\s+the\s+top\s*$/i.test(
      text,
    )
  )
    return null;
  const m = TEXT_ADD.exec(text.trim());
  if (!m) return null;
  const words = m[1].trim().replace(/\s+/g, " ");
  if (!words) return null;
  const where = (m[2] ?? "top").toLowerCase();
  const placement: TextPlacement =
    where === "bottom" ? "bottom" : where === "top" ? "top" : "middle";
  return { words, placement };
}

// ─── Adds that are always edits (W-4, ADI-R19-W) ─────────────────────────────────────────────────────────

/** "add a ball", "put a trophy", "add some confetti" — an add with NO place: the whole sentence, one to three words. */
const PLACELESS_ADD =
  /^(?:please\s+)?(?:add|put|place|stick)\s+(?:a|an|some|the|this|these|two|three)\s+[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,2}\s*[.!]?$/i;

/** The place a placeless add is given (W-4): beside her — the same place her Product photo's add defaults to. */
export const PLACELESS_PLACE = "next to me";

/** An add with no place, read with PLACELESS_PLACE — or null when the sentence is not a bare add. */
export function withDefaultPlace(text: string): string | null {
  return PLACELESS_ADD.test(text.trim())
    ? `${text.trim().replace(/[.!]$/, "")} ${PLACELESS_PLACE}`
    : null;
}

/**
 * "make me hold the bottle", "have me hold a trophy in my hand" — holding a thing is an ADD in her hand (W-4), not a
 * pose. The add sentence to read, or null when it is not one ("…hold the ball over my head" names a place a hand add
 * cannot take, and asks).
 */
const HOLD =
  /^(?:please\s+)?(?:make|have|get|let)\s+me\s+hold(?:ing)?\s+((?:a|an|the|this|these|my|some|two|three)\s+[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,2})(?:\s+in\s+(?:my|both|one)\s+hands?)?\s*[.!]?$/i;
export function readHoldAdd(text: string): string | null {
  const m = HOLD.exec(text.trim());
  return m ? `add ${m[1]} in my hand` : null;
}
/** A sentence that asks her to hold something at all — an add, whatever else it says, so it asks as one (W-4). */
export const NAMES_A_HOLD = /\b(?:make|have|get|let)\s+me\s+hold(?:ing)?\b/i;

// ─── A camera change with no angle (W-5, ADI-R19-W) ──────────────────────────────────────────────────────

const ANGLE_UNCLEAR: readonly RegExp[] = [
  /^(?:change|switch|fix|move|try) (?:the |a )?(?:camera )?(?:angle|view|perspective|camera)$/,
  /^(?:try |use )?(?:a |another )?(?:different|new|better) (?:angle|camera angle|perspective)$/,
  /^(?:shoot|show|photograph) (?:it|this|me) from (?:a )?(?:different|new|another) angle$/,
];
/** "change the angle" with no angle named: it asks, with ANGLE_SUGGESTIONS (W-5). */
export function readAngleUnclear(text: string): boolean {
  const s = plain(text);
  return ANGLE_UNCLEAR.some((re) => re.test(s));
}
/** The angle ask's chips — each routes to CAMERA on its own (imageOps.test pins it). */
export const ANGLE_SUGGESTIONS: readonly string[] = [
  "shoot this from a low angle",
  "shoot this from above",
  "make it an overhead shot",
];
