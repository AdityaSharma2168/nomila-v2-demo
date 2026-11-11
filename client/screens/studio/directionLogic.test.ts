/**
 * directionLogic.test — the client's half of the channel: what arrives is held as data, unchanged, and
 * the confirm step tells literal from inferred.
 *
 * The fixture is the SERVER's own tool (`echoBrief`), round-tripped through JSON as the wire does it —
 * the same import-the-server discipline brandPlan.test uses for validateCampaignBrief. So this suite
 * holds the whole path: tool → wire → reader → validated on the client by the server's own schema.
 *
 * ⚠️ MUTATION: make the reader accept a string or a `{ text }` wrapper — "a proposal that arrives as
 * prose, not data, is refused" reds by name.
 */
import { echoBrief } from "../../../server/studio/direction/echo";
import { validateBriefProposal } from "../../../server/studio/direction/envelope";
import { BRAND_MATCH_FIXTURES } from "../../../shared/brandMatch.fixtures";
import {
  JANE_STREET_STORY,
  JANE_STREET_WIRE,
} from "./fixtures/janeStreetBrief";
import { PRIORITIES } from "../../../server/studio/campaign/brief";
import {
  allConfirmed,
  brandMismatch,
  brandNamesMatch,
  composeAskFromBrief,
  CONTEXT_PREFIX,
  describeReference,
  goalToObjective,
  confirmRows,
  inferredPaths,
  INFERRED_PREFIX,
  isUnverifiedMoment,
  labelFor,
  LITERAL_PREFIX,
  needsConfirm,
  pillarsFor,
  readProposal,
  referenceSourceFor,
  renderValue,
  toPriorContext,
  valueAt,
  type BriefProposal,
} from "./directionLogic";

const input = {
  brand: "Solstice",
  productLine: "the matte-black insulated bottle",
};
/** The wire: what the route writes, exactly. */
const wire = () => JSON.stringify(echoBrief(input));
const arrived = () => readProposal(JSON.parse(wire()));

describe("readProposal — the wire, held as data", () => {
  it("what this client holds is byte-identical to what arrived, and valid by the server's own schema", () => {
    const held = arrived();
    expect(held).not.toBeNull();
    // Byte-identical modulo transport: serialising what we hold is the wire again.
    expect(JSON.stringify(held)).toBe(wire());
    // Zod-valid on arrival — the server's strict envelope and brief, run on the client-held object.
    expect(validateBriefProposal(held).ok).toBe(true);
  });

  it("a proposal that arrives as prose, not data, is refused", () => {
    const reasons: string[] = [];
    const reject = (r: string) => reasons.push(r);
    expect(readProposal(wire(), reject)).toBeNull(); // the JSON as a string
    expect(readProposal({ text: wire() }, reject)).toBeNull(); // wrapped in prose
    expect(
      readProposal("Here is your brief: Solstice, calm and focused.", reject),
    ).toBeNull();
    expect(readProposal(null, reject)).toBeNull();
    expect(reasons).toEqual([
      "payload is not an object",
      "brief is not an object",
      "payload is not an object",
      "payload is not an object",
    ]);
  });

  it("a flag without its evidence field is refused — literal needs its quote, inferred its because", () => {
    const p = JSON.parse(wire());
    const noQuote = { ...p, flags: [{ path: "brand.name", basis: "literal" }] };
    const noBecause = {
      ...p,
      flags: [{ path: "brand.name", basis: "inferred" }],
    };
    const badBasis = {
      ...p,
      flags: [{ path: "brand.name", basis: "guessed", because: "x" }],
    };
    const reasons: string[] = [];
    expect(readProposal(noQuote, (r) => reasons.push(r))).toBeNull();
    expect(readProposal(noBecause, (r) => reasons.push(r))).toBeNull();
    expect(readProposal(badBasis, (r) => reasons.push(r))).toBeNull();
    expect(reasons).toEqual([
      "flags.0 is literal with no quote",
      "flags.0 is inferred with no because",
      "flags.0.basis is not literal|inferred",
    ]);
  });

  it("the wrong version tag, a missing tool name and malformed extras are each refused by name", () => {
    const p = JSON.parse(wire());
    const cases: [unknown, string][] = [
      [
        { ...p, brief: { ...p.brief, schema: "campaign-brief/2" } },
        "brief.schema is not campaign-brief/1",
      ],
      [{ ...p, sourceTool: "" }, "sourceTool is not named"],
      [
        { ...p, extras: { constraints: "none" } },
        "extras.constraints is not a list of lines",
      ],
      [
        { ...p, extras: { constraints: [], concept: { angle: "x" } } },
        "extras.concept is not a concept",
      ],
      [{ ...p, flags: "none" }, "flags is not a list"],
    ];
    for (const [raw, reason] of cases) {
      let got = "";
      expect(readProposal(raw, (r) => (got = r))).toBeNull();
      expect(got).toBe(reason);
    }
  });

  it("a tool's notes and its extraction verdict ride in extras, unchanged — and a malformed one is refused", () => {
    const p = JSON.parse(wire());
    const withExtras = {
      ...p,
      extras: {
        constraints: ["Do not show competitor logos."],
        notes: ["Read the first 20,000 of 31,000 characters."],
        extraction: "unavailable",
      },
    };
    const held = readProposal(withExtras);
    expect(held?.extras).toEqual(withExtras.extras);
    expect(JSON.stringify(held)).toBe(JSON.stringify(withExtras));
    let got = "";
    expect(
      readProposal(
        { ...p, extras: { constraints: [], extraction: "maybe" } },
        (r) => (got = r),
      ),
    ).toBeNull();
    expect(got).toBe("extras.extraction is not text|unavailable");
    expect(
      readProposal(
        { ...p, extras: { constraints: [], notes: "one" } },
        (r) => (got = r),
      ),
    ).toBeNull();
    expect(got).toBe("extras.notes is not a list of lines");
  });
});

describe("the confirm step's rows", () => {
  it("tells literal from inferred: the prefix, the note, and the line's own value", () => {
    const p = arrived()!;
    const rows = confirmRows(p);
    expect(rows).toHaveLength(p.flags.length);
    const brand = rows.find((r) => r.path === "brand.name")!;
    expect(brand).toEqual({
      path: "brand.name",
      label: "Brand",
      value: "Solstice",
      basis: "literal",
      note: "“Solstice”",
      context: false,
      accessibilityLabel: `${LITERAL_PREFIX}: Brand, Solstice`,
    });
    const feel = rows.find((r) => r.path === "creative_direction.tone")!;
    expect(feel.basis).toBe("inferred");
    expect(feel.value).toBe("calm · focused");
    expect(feel.note).toMatch(/fixed sample/);
    expect(feel.accessibilityLabel).toBe(
      `${INFERRED_PREFIX}: Feel, calm · focused`,
    );
    // Every row is one or the other, and says which first.
    for (const r of rows)
      expect(
        r.accessibilityLabel.startsWith(
          r.basis === "inferred" ? INFERRED_PREFIX : LITERAL_PREFIX,
        ),
      ).toBe(true);
  });

  it("nothing proceeds unconfirmed: every inferred line must be tapped, literal lines are read", () => {
    const p = arrived()!;
    const inferred = inferredPaths(p);
    expect(inferred.length).toBeGreaterThan(0);
    expect(inferred).not.toContain("brand.name");
    expect(allConfirmed(p, new Set())).toBe(false);
    expect(allConfirmed(p, new Set(inferred.slice(0, -1)))).toBe(false);
    expect(allConfirmed(p, new Set(inferred))).toBe(true);
    // Confirming the literal lines changes nothing — they were never in question.
    expect(
      allConfirmed(
        p,
        new Set([...inferred.slice(0, -1), "brand.name", "product.line"]),
      ),
    ).toBe(false);
  });

  it("reads a value by path and renders it as a line", () => {
    const p = arrived()!;
    expect(valueAt(p.brief, "output.aspect_ratio")).toBe("9:16");
    expect(valueAt(p.brief, "brand.slogan")).toBeUndefined();
    expect(valueAt(p.brief, "story")).toBeNull();
    expect(renderValue(null)).toBe("—");
    expect(renderValue([])).toBe("—");
    expect(renderValue(["calm", "focused"])).toBe("calm · focused");
    expect(renderValue("showcase-product")).toBe("showcase-product");
    expect(renderValue("brand_campaign")).toBe("brand campaign");
  });

  it("labels the paths a brief has, and humanises one it does not know", () => {
    expect(labelFor("creative_direction.tone")).toBe("Feel");
    expect(labelFor("output.aspect_ratio")).toBe("Aspect ratio");
    expect(labelFor("brand.tag_line")).toBe("Tag line");
  });
});

/** A moment as research_moment writes it: the echo's brief under the tool's own extras, valid by the server's schema. */
const momentArrived = (
  sources: {
    title: string | null;
    url: string | null;
    domain: string | null;
  }[],
) => {
  const base = echoBrief(input);
  const wireObj = {
    ...base,
    sourceTool: "research_moment",
    brief: { ...base.brief, story: "Derby week: Crosstown United at home" },
    flags: [
      ...base.flags,
      {
        path: "story",
        basis: "inferred",
        because: "found by web search — localpaper.example",
      },
      {
        path: "extras.concept",
        basis: "inferred",
        because: "the angle the moment offers",
      },
    ],
    extras: {
      constraints: [],
      concept: {
        angle: "the week before the derby",
        feeling: "charged",
        line: "Derby week.",
      },
      notes: ["Found by web search: 2 sources cited."],
      moment: {
        title: "Derby week: Crosstown United at home",
        summary: "The town's derby returns.",
        sources,
        searchQueries: ["crosstown derby"],
        dateBasis: "none",
        timingRemoved: [],
      },
    },
  };
  const v = validateBriefProposal(wireObj);
  expect(v.ok ? "ok" : v.issues.join("; ")).toBe("ok");
  return readProposal(JSON.parse(JSON.stringify(wireObj)))!;
};
const CITED = [
  {
    title: "Derby preview",
    url: "https://r.example/a",
    domain: "localpaper.example",
  },
];

describe("brand names, matched the server's way", () => {
  it("agrees with shared/brandMatch.fixtures.ts — the table the server's copy is pinned to as well", () => {
    for (const f of BRAND_MATCH_FIXTURES)
      expect({ ...f, got: brandNamesMatch(f.a, f.b) }).toEqual({
        ...f,
        got: f.match,
      });
  });

  /** ⚠️ MUTATION: return [] from brandMismatch — this reds by name. */
  it("a product photo that shows another brand is said, not swallowed — the post's own brand and its variants are not", () => {
    expect(
      brandMismatch(["Nike", "Adidas Originals", "nike", " "], "adidas"),
    ).toEqual(["Nike"]);
    expect(brandMismatch(["Adidas"], "Adidas Originals")).toEqual([]);
    expect(brandMismatch(null, "adidas")).toEqual([]);
    expect(brandMismatch(undefined, "adidas")).toEqual([]);
  });
});

describe("moments: verified or not, and what may stack", () => {
  it("an unverified moment is never skipped; a cited one needs the confirm for its inferred lines; a proposal with nothing inferred goes straight on", () => {
    expect(isUnverifiedMoment(momentArrived([]))).toBe(true);
    expect(isUnverifiedMoment(momentArrived(CITED))).toBe(false);
    expect(needsConfirm(momentArrived([]))).toBe(true);
    expect(needsConfirm(momentArrived(CITED))).toBe(true);
    // The case that tells the two halves apart (mutation E-M2 found the first fixture could not): an
    // unverified moment with NOTHING inferred is still never skipped.
    const unverifiedLiteralOnly = momentArrived([]);
    unverifiedLiteralOnly.flags = unverifiedLiteralOnly.flags.filter(
      (f) => f.basis === "literal",
    );
    expect(inferredPaths(unverifiedLiteralOnly)).toEqual([]);
    expect(needsConfirm(unverifiedLiteralOnly)).toBe(true);
    const literalOnly = {
      ...momentArrived(CITED),
      sourceTool: "summarize_brief",
    };
    literalOnly.flags = literalOnly.flags.filter((f) => f.basis === "literal");
    expect(inferredPaths(literalOnly)).toEqual([]);
    expect(needsConfirm(literalOnly)).toBe(false);
  });

  /** ⚠️ MUTATION: drop the guard in toPriorContext — this reds by name. */
  it("an unverified moment stacks only through her confirm tap, never by default; a cited one stacks as it is", () => {
    expect(toPriorContext(momentArrived([]))).toBeNull();
    expect(toPriorContext(momentArrived([]), { confirmed: false })).toBeNull();
    const stacked = toPriorContext(momentArrived([]), { confirmed: true });
    expect(stacked?.sourceTool).toBe("research_moment");
    expect(stacked?.lines).toEqual([
      "Derby week: Crosstown United at home",
      "The town's derby returns.",
      "Angle: the week before the derby",
      "Feel: charged",
      "Tone: calm, focused", // the echo brief's own tone rides along
    ]);
    expect(toPriorContext(momentArrived(CITED))?.lines.length).toBe(5);
  });
});

describe("the doors the brief step draws", () => {
  /** ⚠️ MUTATION: draw a door with plansOntoBoard false — this reds by name (the control cell). */
  it("flags off: no doors, and the upload door is today's stub; on: the pillars, the moment one only with its own flag", () => {
    expect(pillarsFor({ plansOntoBoard: false, moments: true })).toEqual({
      readsBrief: false,
      doors: [],
    });
    expect(pillarsFor({ plansOntoBoard: true, moments: false })).toEqual({
      readsBrief: true,
      doors: ["reference", "ideas", "trend"],
    });
    expect(pillarsFor({ plansOntoBoard: true, moments: true }).doors).toEqual([
      "moment",
      "reference",
      "ideas",
      "trend",
    ]);
  });

  it("a pasted reference is a link when it reads as one, otherwise the words; nothing is nothing", () => {
    expect(referenceSourceFor(" https://brand.example/look.jpg ")).toEqual({
      kind: "url",
      url: "https://brand.example/look.jpg",
    });
    expect(referenceSourceFor("a soccer ad, calm and clean")).toEqual({
      kind: "text",
      text: "a soccer ad, calm and clean",
    });
    expect(referenceSourceFor("   ")).toBeNull();
  });
});

describe("the confirm step's rows — the extras paths", () => {
  /** ⚠️ MUTATION: read every path off the brief in valueFor — this reds by name. */
  it("a constraint row shows its own words under a label that says which kind it is; a concept row shows its three lines", () => {
    const base = arrived()!;
    const p = {
      ...base,
      flags: [
        ...base.flags,
        {
          path: "extras.constraints.0",
          basis: "literal" as const,
          quote: "Do not show competitor logos.",
        },
        {
          path: "extras.constraints.1",
          basis: "literal" as const,
          quote: "Tag @janestreet in the caption.",
        },
        {
          path: "extras.concept",
          basis: "inferred" as const,
          because: "proposed for grow-following",
        },
      ],
      extras: {
        ...base.extras,
        constraints: [
          "Do not show competitor logos.",
          "Tag @janestreet in the caption.",
        ],
        concept: {
          angle: "the quiet hour",
          feeling: "calm",
          line: "Before the day is anyone else's.",
        },
      },
    };
    const rows = confirmRows(p);
    const byPath = (path: string) => rows.find((r) => r.path === path)!;
    expect(byPath("extras.constraints.0")).toMatchObject({
      label: "Do not",
      value: "Do not show competitor logos.",
      basis: "literal",
      note: "“Do not show competitor logos.”",
    });
    expect(byPath("extras.constraints.1")).toMatchObject({
      label: "Requirement",
      value: "Tag @janestreet in the caption.",
      basis: "literal",
    });
    expect(byPath("extras.concept")).toMatchObject({
      label: "Concept",
      value: "the quiet hour · calm — Before the day is anyone else's.",
      basis: "inferred",
    });
    expect(rows.every((r) => r.value !== "—")).toBe(true);
  });
});

describe("the composed ask — we analysed this brief, and the ask reads like it", () => {
  const janeStreet = () => {
    const v = validateBriefProposal(JANE_STREET_WIRE);
    expect(v.ok ? "ok" : v.issues.join("; ")).toBe("ok");
    return readProposal(JSON.parse(JSON.stringify(JANE_STREET_WIRE)))!;
  };

  /** ⚠️ MUTATION: return the one-line fallback from composeAskFromBrief — this reds by name. */
  it("a confirmed brief composes a full ask: deliverable, platform, goal, story and the confirmed lines — never the fallback", () => {
    const { prompt, aesthetic, objective } = composeAskFromBrief(
      janeStreet(),
      "Jane Street",
    );
    expect(prompt).toBe(
      "A 9:16 video for Instagram, for Jane Street — to announce campus internship program. " +
        JANE_STREET_STORY +
        " In my own footage style, with me clearly in it.",
    );
    expect(prompt).not.toMatch(/^A video for Jane Street/); // the no-brief fallback sentence
    expect(prompt.length).toBeLessThanOrEqual(2000);
    expect(aesthetic).toBe("understated, precise, quietly confident");
    expect(objective).toBe("announce");
    // Constraints are not creative direction: none of them enters the visible ask.
    expect(prompt).not.toMatch(/janestreet|#ad|competitor|financial/i);
  });

  /** ⚠️ MUTATION "identity_priority maximum produces no phrase" (PR 10, R-4): drop `maximum` from IDENTITY_WORDS. */
  it("every member of the schema's identity_priority enum composes a phrase — maximum, high and standard each read differently", () => {
    const phrases = PRIORITIES.map((priority) => {
      const p = janeStreet();
      (p.brief as unknown as { subject: { identity_priority: string } }).subject.identity_priority = priority;
      const { prompt } = composeAskFromBrief(p, "Jane Street");
      const m = /\. In my own footage style, (with me [a-z ]*in it)\.$/.exec(prompt);
      return [priority, m?.[1] ?? null] as const;
    });
    for (const [priority, phrase] of phrases) expect([priority, phrase]).toEqual([priority, expect.any(String)]);
    expect(new Set(phrases.map(([, ph]) => ph)).size).toBe(PRIORITIES.length);
    expect(phrases.find(([p]) => p === "high")?.[1]).toBe("with me clearly in it");
  });

  it("every phrase is a confirmed line plus glue: nothing in the ask that the brief did not say", () => {
    const p = janeStreet();
    const { prompt } = composeAskFromBrief(p, "Jane Street");
    const said = JSON.stringify(p.brief).toLowerCase();
    // Every content word in the ask is on the brief (glue words are the short list below).
    const glue = new Set([
      "a",
      "for",
      "to",
      "announce",
      "in",
      "her",
      "my",
      "me",
      "own",
      "footage",
      "style",
      "with",
      "clearly",
      "it",
      "and",
      "the",
      "way",
      "—",
      "video",
    ]);
    for (const w of prompt
      .toLowerCase()
      .replace(/[.,—]/g, " ")
      .split(/\s+/)
      .filter(Boolean))
      expect(glue.has(w) || said.includes(w)).toBe(true);
  });

  it("the brief's goal is the purpose chip, one vocabulary; a goal it does not know is none", () => {
    expect(goalToObjective("recap")).toBe("recap");
    expect(goalToObjective("virality")).toBeNull();
  });
});

describe("structured values on the confirm step", () => {
  const dims = (n: number) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        `dim_${i}`,
        { summary: `d${i}`, basis: "observed" },
      ]),
    );
  /** A decompose_reference proposal, as the wire carries it (the reference structured, its intent nested). */
  const withReference = (): BriefProposal => {
    const base = arrived()!;
    return readProposal(
      JSON.parse(
        JSON.stringify({
          ...base,
          sourceTool: "decompose_reference",
          brief: {
            ...base.brief,
            references: [
              { ref: "ref_1", role: "style_reference", intent: dims(9) },
            ],
          },
          flags: [
            ...base.flags,
            {
              path: "references",
              basis: "inferred",
              because:
                "the reference, decomposed along 9 dimensions (9 observed, 0 inferred)",
            },
          ],
        }),
      ),
    )!;
  };

  /** ⚠️ MUTATION: `String(v)` for an object in renderValue — this reds by name. */
  it("no row ever renders [object Object]: a reference is its role and how much was read; any other object its scalar fields", () => {
    expect(
      renderValue([{ ref: "ref_1", role: "style_reference", intent: dims(9) }]),
    ).toBe("style reference · read on 9 of 12 dimensions");
    expect(
      describeReference({
        ref: "ref_1",
        role: "composition_reference",
        intent: null,
      }),
    ).toBe("composition reference · not read yet");
    expect(
      renderValue({ name: "Solstice", brand_attributes: ["a"], profile: null }),
    ).toBe("name: Solstice · profile: —");
    expect(renderValue({})).toBe("—");
    // The sweep: every row of every fixture this suite holds, and the reference one.
    for (const p of [
      arrived()!,
      momentArrived([]),
      readProposal(JSON.parse(JSON.stringify(JANE_STREET_WIRE)))!,
      withReference(),
    ])
      for (const r of confirmRows(p)) {
        expect(r.value).not.toContain("[object Object]");
        expect(r.accessibilityLabel).not.toContain("[object Object]");
      }
  });

  /** ⚠️ MUTATION: empty CONTEXT_PATHS — this reds by name. */
  it("the references row is context: read, never tapped — 'Use this brief' needs the other inferred lines only", () => {
    const p = withReference();
    const row = confirmRows(p).find((r) => r.path === "references")!;
    expect(row).toMatchObject({
      context: true,
      value: "style reference · read on 9 of 12 dimensions",
      accessibilityLabel: `${CONTEXT_PREFIX}: References, style reference · read on 9 of 12 dimensions`,
    });
    expect(inferredPaths(p)).not.toContain("references");
    expect(allConfirmed(p, new Set(inferredPaths(p)))).toBe(true);
    expect(allConfirmed(p, new Set())).toBe(false); // the echo's own inferred lines still need their taps
  });
});
