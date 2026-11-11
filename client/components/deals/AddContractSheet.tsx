/**
 * AddContractSheet — she hands us a deal we never saw.
 *
 * The app learned about deals by reading her mail, which meant a deal that never touched
 * her inbox could not exist. Her signed adidas endorsement was invisible for exactly that
 * reason. This is the door.
 *
 * THE ORDER MATTERS: pick → upload → read → REVIEW → save. The review step is not a
 * formality. What she confirms here becomes her commercial capital, so the numbers must
 * be hers, not a model's. Extraction pre-fills the form and nothing more — when it fails,
 * and it will on a scanned contract with no text layer, the form still works and she
 * types four fields.
 *
 * Only the fields `deals` can actually hold are shown. A real contract carries far more —
 * a payment schedule, exclusivity, appearance counts — and that is kept whole in raw_data
 * rather than being flattened into inputs that would misrepresent it. Showing her a single
 * "amount" box for a five-year schedule would be asking her to confirm something untrue.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, Modal, Pressable, TextInput, ScrollView,
  ActivityIndicator, StyleSheet, Switch, KeyboardAvoidingView, Platform,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
// SDK 54 moved the classic FileSystem API (uploadAsync) to the `legacy` entry.
import * as FileSystem from "expo-file-system/legacy";
import { apiRequest } from "../../lib/query-client";
import { tap, success as hapticSuccess, warning as hapticWarning } from "../../lib/haptics";
import { scheduleSummary, usdShort } from "./scheduleMoney";
import { contractChanges, type CurrentTerms } from "./contractChanges";
import { BrandLogo } from "../BrandLogo";
import { useDeals } from "../../hooks/use-deals";
import { Colors, Fonts, Spacing, BorderRadius } from "../../constants/theme";

type Step = "source" | "working" | "destination" | "chooseDeal" | "brandPick" | "review";

/** One of her brands, as the picker lists it. */
interface BrandOption { brand_id: number; name: string | null; domain: string | null; logo_url: string | null }

/** A brand she already works with, found by searching the document for its name. */
interface BrandMention { brand_id: number; name: string; mentions: number; first_at: number }

/** A deal on that brand, as the chooser lists it. */
interface ScanDeal {
  id: string; brand_name: string | null; brand_id: number | null;
  amount: string | null; status: string | null; deal_type: string | null;
  detected_at: string | null;
}

/** What the no-model scan found. Everything here is a proposal, never a decision. */
interface ContractScan { readable: boolean; chars: number; mentions: BrandMention[]; deals: ScanDeal[] }

/**
 * Where the contract is going.
 *
 * Held explicitly rather than inferred at save time. `existing` posts the terms onto a
 * deal that is already there; `fresh` mints one. Nothing else decides this — the write
 * path follows what she said, not what the extract turned out to contain.
 */
type Destination = { kind: "existing"; dealId: string } | { kind: "fresh" };

/**
 * One row of the schedule, as she can edit it.
 *
 * This IS the form. She used to edit a single "cash this year" box that went to
 * deals.amount, while the model's untouched schedule went to deal_periods — which is what
 * the card and the detail screen actually read. So the figure she corrected was the one
 * discarded, and the one she rejected was the one she saw.
 *
 * Editing the schedule directly removes the second place for money to live.
 */
interface EditablePeriod {
  label: string | null;
  starts_on: string | null;
  ends_on: string | null;
  cash: string;              // held as text so a half-typed figure is not a number yet
  product: string;
  product_directed: number | null;
  conditional: boolean;
  condition: string | null;
  source_quote: string | null;
}

interface Suggested {
  amount_cash:    number | null;
  amount_product: number | null;
  term_start:     string | null;
  term_end:       string | null;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Fired after the deal is created OR updated, so the list can refetch. */
  onCreated: (dealId: string) => void;
  /**
   * The deal this contract belongs to, when the caller already knows.
   *
   * Set when the sheet is opened from a deal's own screen. The destination question is
   * then skipped entirely — the answer is a fact, not a guess.
   */
  dealId?: string;
  /**
   * The request she raised that this upload answers ("prompt me for my contract"), when opened from Mila's
   * waiting-on-you chip. Sent with the save so the reviewed contract becomes evidence for that request.
   */
  requestId?: string;
  /**
   * An attachment already on that deal's thread, to read instead of asking for a file.
   *
   * A contract usually arrives by email. Hers has been in the bucket since 15 August,
   * parsed, on the right thread — and until now the only way to hand it to the extractor
   * was to find the PDF again on her phone and upload a second copy.
   */
  attachment?: { messageId: string; index: number };
}

/** Where the contract is coming from. */
type Source = "camera" | "photos" | "files";

/** What every source returns, reduced to what the upload needs. */
interface PickedFile { uri: string; name: string; mimeType: string; size: number | null; file?: unknown }

/**
 * Take a photo, choose one, or browse files — each its own native picker.
 *
 * Returns null when she backs out, which is a normal answer and not an error.
 * Throws only when a source is genuinely unavailable, which the caller reports.
 */
async function pickFrom(source: Source): Promise<PickedFile | null> {
  if (source === "files") {
    const r = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"],
      copyToCacheDirectory: true,
    });
    if (r.canceled || !r.assets?.length) return null;
    const a = r.assets[0];
    // Trust the picker's type, falling back to the extension — a HEIC from the camera
    // roll sometimes arrives with no mimeType at all.
    const guess = (a.name ?? "").toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg";
    return {
      uri: a.uri,
      name: a.name ?? "contract.pdf",
      mimeType: a.mimeType || guess,
      size: a.size ?? null,
      file: (a as any).file,
    };
  }

  const perm =
    source === "camera"
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    throw new Error(source === "camera"
      ? "Nomila needs camera access to photograph a contract. You can turn it on in Settings."
      : "Nomila needs access to your photos to use one. You can turn it on in Settings.");
  }

  const r =
    source === "camera"
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });
  if (r.canceled || !r.assets?.length) return null;
  const a = r.assets[0];
  return {
    uri: a.uri,
    name: a.fileName ?? `contract-${Date.now()}.jpg`,
    mimeType: a.mimeType ?? "image/jpeg",
    size: a.fileSize ?? null,
    file: (a as any).file,
  };
}

/** Digits only, so "$20,000" and "20000" both land as 20000. Empty stays null, never 0. */
function toNumber(s: string): number | null {
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return s.trim() && Number.isFinite(n) ? n : null;
}

export function AddContractSheet({ visible, onClose, onCreated, dealId, attachment, requestId }: Props) {
  const [step, setStep]   = useState<Step>("source");
  const [note, setNote]   = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The uploaded object + whatever we managed to read from it.
  const [gcsPath, setGcsPath]   = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [bytes, setBytes]       = useState<number | null>(null);
  const [extract, setExtract]   = useState<unknown>(null);
  // Her answer at review: is this contract exclusive? true · false · null (not sure / not asked). Only her `true`
  // lets Nomila treat the clause as a bound on what it recommends.
  const [exclusivityConfirmed, setExclusivityConfirmed] = useState<boolean | null>(null);

  // What the document says about brands she already has, and where she decided it goes.
  const [scan, setScan] = useState<ContractScan | null>(null);
  // What the deal she is attaching to holds RIGHT NOW. Null for a new deal, which replaces
  // nothing — a diff against an absence is just the form itself.
  const [current, setCurrent] = useState<CurrentTerms | null>(null);

  // The brand chooser. `contractBrand` is what the DOCUMENT called it — kept separate
  // from brandName, because the legal signatory and the name she uses are different
  // things and she needs to see both to judge the match.
  const [contractBrand, setContractBrand] = useState("");
  const [brandQuery, setBrandQuery] = useState("");
  const [brandOptions, setBrandOptions] = useState<BrandOption[]>([]);
  const [brandSearching, setBrandSearching] = useState(false);
  // Seeded from the prop: opened from a deal, the question is already answered.
  const [destination, setDestination] = useState<Destination | null>(
    dealId ? { kind: "existing", dealId } : null,
  );

  // The form she confirms.
  const [brandName, setBrandName] = useState("");
  // The schedule she is confirming. One row for a single-term deal, several for a
  // multi-year contract — the same control either way.
  const [periods, setPeriods]     = useState<EditablePeriod[]>([]);
  const [termStart, setTermStart] = useState("");
  const [termEnd, setTermEnd]     = useState("");
  const [signed, setSigned]       = useState(true);

  // The named figures, computed from what is IN THE FORM rather than from the extract, so
  // they move as she corrects a number. That is the point of showing them here: she can see
  // her own arithmetic before she commits to it.
  const summaryRows = (() => {
    const guaranteed = periods.filter((r) => !r.conditional);
    if (!guaranteed.length) return [];
    // Unknown is not zero: if any guaranteed row has no cash figure, there is no honest
    // total to show — the same rule the card and the resolver follow.
    const anyUnknown = guaranteed.some((r) => toNumber(r.cash) == null && r.cash.trim() === "");
    const rowTotal = (r: EditablePeriod) => (toNumber(r.cash) ?? 0) + (toNumber(r.product) ?? 0);
    const tcv = anyUnknown ? null : guaranteed.reduce((n, r) => n + rowTotal(r), 0);
    const cur = guaranteed[0];
    return scheduleSummary({
      acvCents: anyUnknown ? null : rowTotal(cur) * 100,
      acvUnknown: anyUnknown,
      tcvCents: tcv == null ? null : tcv * 100,
      aavCents: tcv == null ? null : Math.round((tcv * 100) / guaranteed.length),
      conditionalCents: periods.filter((r) => r.conditional).reduce((n, r) => n + rowTotal(r), 0) * 100 || null,
    });
  })();

  // Read straight off the extract we already hold — no second source of truth.
  const ex: any = extract ?? null;
  const schedule: any[] = Array.isArray(ex?.cash_schedule) ? ex.cash_schedule : [];
  const charitable: number | null =
    schedule.find((r: any) => r?.product_directed != null)?.product_directed ?? null;
  // We read the contract twice and kept only what both reads saw. Anything they
  // disagreed about is named here so she can check it against the document.
  const divergent: string[] = Array.isArray(ex?.agreement?.divergent) ? ex.agreement.divergent : [];

  // null means the extractor could not tell — which must be shown, not silently read as 'no'.
  const exclusivity: boolean | null =
    ex?.exclusivity?.exists === undefined ? null : ex.exclusivity.exists;

  function reset() {
    setStep("source"); setNote(null); setError(null);
    setScan(null); setCurrent(null);
    setDestination(dealId ? { kind: "existing", dealId } : null);
    setGcsPath(null); setFilename(null); setBytes(null); setExtract(null);
    setBrandName(""); setPeriods([]); setTermStart(""); setTermEnd("");
    setContractBrand(""); setBrandQuery(""); setBrandOptions([]);
    setSigned(true);
    setExclusivityConfirmed(null);
  }

  function close() { reset(); onClose(); }

  /**
   * Opened from a deal's own attachment, the work starts by itself.
   *
   * There is no file to choose — it is already in the bucket — and no destination to
   * settle, because the attachment rides a thread on that deal. The ref guard matters
   * because a Modal re-renders on every keystroke once she is in the form, and without it
   * the read would restart underneath her.
   */
  const autoStart = useRef(false);

  /**
   * Start the work, once the sheet is actually on screen.
   *
   * Only the attachment path starts by itself now. The + button used to auto-present the
   * document picker from here, which meant presenting a system sheet over a pageSheet that
   * was itself mid-presentation — iOS swallows that silently, and no amount of onShow or
   * runAfterInteractions made it reliable. It asks her where the contract is instead.
   */
  function begin() {
    if (autoStart.current) return;
    autoStart.current = true;
    // From a deal's own attachment the work starts by itself: there is no file to choose
    // and no destination to settle. The + button now asks where the contract is coming
    // from instead of guessing that it is a file.
    if (attachment && dealId) void readContract(null);
  }

  // Reset the guard when the sheet closes, so the next opening starts again.
  useEffect(() => { if (!visible) autoStart.current = false; }, [visible]);

  /** Get the file from wherever she said, PUT it to GCS, then ask the server about it. */
  async function pickAndUpload(source: Source) {
    tap();
    setError(null);
    // Leave the chooser BEFORE presenting: it used to sit behind the picker for as long as
    // it was open, so every upload flashed a screen underneath the OS sheet.
    setStep("working");
    setNote(null);
    // Tracked locally, not from state: setGcsPath below is queued, so this function can
    // never observe it.
    let uploaded: string | null = null;
    try {
      let picked: PickedFile | null;
      try {
        picked = await pickFrom(source);
      } catch (permErr: any) {
        // A source that is unavailable is not a failed upload. Say what is wrong and leave
        // her on the chooser, where the other two still work.
        setError(permErr?.message ?? "That source isn't available.");
        setStep("source");
        return;
      }
      // Backing out of a picker is a normal answer, not a decision to abandon everything.
      if (!picked) { setStep("source"); return; }

      const contentType = picked.mimeType;
      setNote("Uploading…");
      setFilename(picked.name);
      setBytes(picked.size);

      const mintRes = await apiRequest("POST", "/api/v1/me/deals/contract/upload-url", {
        filename:    picked.name,
        contentType,
        bytes:       picked.size ?? undefined,
      });
      const mint = await mintRes.json();
      uploaded = mint.gcsPath ?? null;

      // Straight to GCS — the API never carries the file. Streamed from disk rather than
      // buffered: `fetch(uri).blob()` pulls the whole file into JS memory and dies on a
      // large one in React Native, which is the bug PR #162 fixed in the media path. This
      // file had the identical line.
      // Web takes its own branch. expo-file-system's uploadAsync does not exist there —
      // the web shim ships the directory constants and nothing else, so this threw
      // UnavailabilityError and the whole flow died after she had already chosen a file.
      // Native keeps uploadAsync deliberately: it streams from disk, where fetch(uri).blob()
      // buffers the entire file in JS memory and dies on a large one (the bug PR #162 fixed
      // in the media path).
      if (Platform.OS === "web") {
        const body = (picked.file as Blob | undefined) ?? (await (await fetch(picked.uri)).blob());
        const put = await fetch(mint.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body,
        });
        if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      } else {
        const put = await FileSystem.uploadAsync(mint.uploadUrl, picked.uri, {
          httpMethod: "PUT",
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: { "Content-Type": contentType },
        });
        if (put.status < 200 || put.status >= 300) throw new Error(`Upload failed (${put.status})`);
      }
      setGcsPath(mint.gcsPath);

      // Ask where this belongs BEFORE spending a model call. The scan is pdf text plus a
      // search for brands she already has — about a second, and no AI at all.
      setNote("Looking at the file…");
      const scanRes = await apiRequest("POST", "/api/v1/me/deals/contract/scan", {
        gcsPath: mint.gcsPath,
      });
      const found: ContractScan = await scanRes.json();
      setScan(found);
      hapticSuccess();

      // Nothing to ask when the caller already named the deal.
      if (destination) { void readContract(mint.gcsPath); return; }

      // A triage screen with no candidates is a screen whose only job is opening search —
      // the same dead hop we deleted at the picker. Go straight there instead.
      setStep(found.mentions.length ? "destination" : "chooseDeal");
    } catch (e: any) {
      hapticWarning();
      setError(e?.message ?? "Something went wrong");
      // A failure AFTER a successful upload used to send her back to the picker to
      // upload the very same file again, because this read null every time.
      setStep(uploaded ? "review" : "source");
    }
  }

  /**
   * Read the contract, then fill the form from what it says.
   *
   * Runs ONLY once the destination is settled. This is the step that costs a model call,
   * and a contract she changes her mind about should cost nothing — so it waits behind the
   * question rather than racing it. By the time it runs we also know the brand, and on the
   * existing-deal path the deal, which is context the read no longer has to infer.
   */
  async function readContract(path: string | null, dest: Destination | null = destination) {
    setStep("working");
    setNote("Reading the contract…");
    setError(null);
    try {
      // Two ways in, one answer shape. From a deal's own thread the file is already ours
      // and is addressed by the message it arrived on; otherwise it is what she just sent.
      const exRes = attachment && dealId
        ? await apiRequest("POST", `/api/v1/me/deals/${dealId}/contract/from-attachment`, {
            messageId: attachment.messageId, index: attachment.index,
          })
        : await apiRequest("POST", "/api/v1/me/deals/contract/extract", {
            gcsPath: path,
            // She has already said where this goes, so the answer can carry what that deal
            // holds today.
            dealId: dest?.kind === "existing" ? dest.dealId : undefined,
          });
      const payload = await exRes.json();
      if (payload.filename) setFilename(payload.filename);
      setCurrent(payload.current ?? null);

      // THREE outcomes, not two. The server distinguishes them and this used to collapse
      // the last two, which is the bug: when the model's answer did not survive, `readable`
      // is still true and the extract comes back all-null — but `signed` can still be true,
      // because that is derived from a completion certificate in the document rather than
      // from the model. So she was told "Read it, check the details below", shown blank
      // amounts, and could save a SIGNED deal worth nothing, believing we had read it.
      if (!payload.readable) {
        // No text and no image we could use. Not a failure — she fills it in.
        setNote(payload.reason ?? "Couldn't read that file — fill in the details yourself.");
      } else if (!payload.parsed) {
        // We read the document; the model's answer did not survive. Marker-derived facts
        // are all we have, and none of them is money.
        setExtract(null);
        setSigned(false);
        setNote("We read the file but couldn't pull the terms out of it — please enter them below.");
      } else {
        const s: Suggested = payload.suggested ?? {};
        setExtract(payload.extract);
        // The name SHE would recognise, ahead of the one the contract is signed with.
        // gorjana's says "GORJANA & GRIFFIN, LLC" and adidas's says "adidas America, Inc.";
        // posting either mints a second brand, because resolveBrand creates on a miss and
        // no safe normalisation gets from one to the other. The scan already established
        // which of her brands the document names, and a name she typed into the search is
        // better still — it is the answer to this exact question.
        // NOT the deal-search box. Typing "gorj" and tapping "Start a new deal with
        // gorj" minted a brand called gorj. That box filters deals; it is not her
        // answer to what the brand is called.
        setBrandName(brandFound?.name || payload.extract.brand || "");
        setContractBrand(payload.extract.brand ?? "");
        // Seed the rows from the contract's own schedule. A contract with no schedule still
        // gets one row, so the control is the same whether it is gorjana or adidas.
        const sched: any[] = Array.isArray(payload.extract.cash_schedule) ? payload.extract.cash_schedule : [];
        setPeriods(sched.length ? sched.map((r: any) => ({
          label:            r.period ?? null,
          starts_on:        r.starts_on ?? null,
          ends_on:          r.ends_on ?? null,
          cash:             r.amount != null ? String(r.amount) : "",
          product:          String(r.product ?? payload.extract.product_per_year ?? ""),
          product_directed: r.product_directed ?? payload.extract.product_directed_per_year ?? null,
          conditional:      r.conditional === true,
          condition:        r.condition ?? payload.extract.term_note ?? null,
          source_quote:     r.source_quote ?? null,
        })) : [{
          label: null, starts_on: s.term_start ?? null, ends_on: s.term_end ?? null,
          cash: s.amount_cash != null ? String(s.amount_cash) : "",
          product: s.amount_product != null ? String(s.amount_product) : "",
          product_directed: null, conditional: false, condition: null, source_quote: null,
        }]);
        setTermStart(s.term_start ?? "");
        setTermEnd(s.term_end ?? "");
        setSigned(payload.extract.signed === true);
        setNote(
          payload.extract.term_conditional
            ? "Read it. The end date depends on a condition — the date below is the outer limit."
            : "Read it. Check the details below.",
        );
      }
      hapticSuccess();
      setStep("review");
    } catch (e: any) {
      hapticWarning();
      setError(e?.message ?? "Something went wrong");
      setStep("review");
    }
  }


  /** Deals worth listing without being asked. The rest are cold outreach; they answer to search. */
  const realDeals = (scan?.deals ?? []).filter(
    (d) => d.status === "accepted" || d.status === "completed" || (d.amount != null && d.amount !== ""),
  );
  const brandFound = scan?.mentions?.[0] ?? null;
  const currentFormPeriod = periods.find((r) => !r.conditional) ?? periods[0] ?? null;

  // Her whole book, for the search fallback. Loaded lazily by react-query and shared with
  // the Opportunities screen, so this costs no extra request in practice.
  const { deals: allDeals } = useDeals();
  const [query, setQuery] = useState("");

  /**
   * Deals worth showing before she types.
   *
   * Roughly 98% of her rows are cold outreach the detector filed and nobody acted on.
   * Listing them makes her scan her own spam to find four real brands, so the default view
   * is the ones with traction and everything else answers to the search box.
   */
  const notableDeals = allDeals.filter(
    (d) => d.status === "accepted" || d.status === "completed" || !!d.offerAmount,
  );
  const q = query.trim().toLowerCase();
  const searchResults = q
    ? allDeals.filter((d) => d.brandName.toLowerCase().includes(q))
    : notableDeals;

  /** How a deal reads in a list: what she'd recognise, not what the row stores. */
  function dealBlurb(d: ScanDeal): string {
    const bits: string[] = [];
    const n = d.amount == null ? null : Number(d.amount);
    if (n != null && Number.isFinite(n) && n > 0) bits.push(usdShort(Math.round(n * 100)));
    if (d.status) bits.push(d.status === "accepted" ? "Accepted" : d.status[0].toUpperCase() + d.status.slice(1));
    return bits.join(" · ");
  }

  /**
   * Her brands, ranked against a query. Read-only by design: nothing on this path may
   * create a brand, because a contract names its signatory rather than its brand and
   * filing one under "adidas America, Inc." is how she ends up with two adidas.
   */
  async function searchBrands(q: string) {
    setBrandSearching(true);
    try {
      const res = await apiRequest("GET", `/api/v1/me/brands/search?q=${encodeURIComponent(q)}`);
      const out = await res.json();
      setBrandOptions(Array.isArray(out.brands) ? out.brands : []);
    } catch {
      // A search that fails leaves her typing the name, which still works.
      setBrandOptions([]);
    } finally {
      setBrandSearching(false);
    }
  }

  /** Open the chooser, seeded with what the contract called the brand. */
  function openBrandPick() {
    tap();
    const seed = contractBrand || brandName;
    setBrandQuery(seed);
    setStep("brandPick");
    void searchBrands(seed);
  }

  /** Settle where it goes, then spend the model call. */
  const busy = useRef(false);

  function choose(dest: Destination) {
    // Two taps in one frame both saw the same step and both fired an extract — two model
    // calls, and on save two deals. A ref rather than state, because state would have the
    // very problem it is guarding against.
    if (busy.current) return;
    busy.current = true;
    tap();
    setDestination(dest);
    // Handed over, not read back: setDestination has only been QUEUED at this point.
    void readContract(gcsPath, dest).finally(() => { busy.current = false; });
  }
  /**
   * What attaching this contract will change about the deal.
   *
   * The comparison lives in contractChanges because it is unit-crossing arithmetic — the
   * deal's figures arrive in integer cents, the form holds dollars — and getting it wrong
   * reports every unchanged figure as changed, which turns the block into noise she learns
   * to skip. Tested there rather than eyeballed here.
   */
  const changeRows = contractChanges(current, {
    cash:        currentFormPeriod ? toNumber(currentFormPeriod.cash) : null,
    product:     currentFormPeriod ? toNumber(currentFormPeriod.product) : null,
    termStart,
    termEnd,
    periodCount: periods.length,
  });

  async function save() {
    // Only a NEW deal needs a brand from her — an existing one already has one, and
    // overwriting it from a contract's legal entity name is how "adidas America, Inc."
    // became a second adidas.
    if (destination?.kind !== "existing" && !brandName.trim()) { setError("Name the brand"); return; }
    tap();
    setStep("working");
    setNote("Saving…");
    setError(null);
    try {
      // Where she said, not what the extract turned out to contain. An existing deal takes
      // the terms onto the row that is already there — periods superseded, never duplicated
      // — which is the whole reason a second gorjana deal no longer appears.
      const toExisting = destination?.kind === "existing" ? destination.dealId : null;
      const res = await apiRequest(
        "POST",
        toExisting ? `/api/v1/me/deals/${toExisting}/contract` : "/api/v1/me/deals/contract",
        {
        gcsPath, filename, bytes,
        ...(attachment ?? {}),
        brandName:      brandName.trim(),
        // The rows SHE confirmed. The server derives deals.amount from these rather than
        // taking a separately-typed figure, so the two can no longer disagree.
        periods: periods.map((r) => ({
          label: r.label, starts_on: r.starts_on, ends_on: r.ends_on,
          cash: toNumber(r.cash), product: toNumber(r.product),
          product_directed: r.product_directed,
          conditional: r.conditional, condition: r.condition, source_quote: r.source_quote,
        })),
        term_start:     termStart.trim() || null,
        term_end:       termEnd.trim() || null,
        signed,
        extract,
        exclusivity_confirmed: exclusivityConfirmed,
        ...(requestId ? { requestId } : {}),
        },
      );
      const out = await res.json();
      hapticSuccess();
      onCreated(out.id ?? toExisting);
      close();
    } catch (e: any) {
      hapticWarning();
      setError(e?.message ?? "Could not save that deal");
      setStep("review");
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
      onShow={begin}
    >
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Pressable onPress={close} hitSlop={10}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Add a deal</Text>
          <View style={{ width: 52 }} />
        </View>

        {step === "source" && (
          <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
            <View style={{ gap: 4 }}>
              <Text style={styles.destLead}>Add a contract</Text>
              <Text style={styles.destSub}>
                A PDF or a photo of it — we read what we can, then you check it.
              </Text>
            </View>

            {/* The document picker is the Files browser: no camera, no photo library. A
                contract reaches an athlete as a photo of a page at least as often as it
                arrives as a PDF, and this flow had no way to take one. */}
            <View style={styles.sourceRow}>
              <Pressable style={styles.sourceTile} onPress={() => pickAndUpload("camera")}>
                <Feather name="camera" size={20} color={Colors.light.text} />
                <Text style={styles.sourceTileLabel}>Camera</Text>
              </Pressable>
              <Pressable style={styles.sourceTile} onPress={() => pickAndUpload("photos")}>
                <Feather name="image" size={20} color={Colors.light.text} />
                <Text style={styles.sourceTileLabel}>Photos</Text>
              </Pressable>
              <Pressable style={styles.sourceTile} onPress={() => pickAndUpload("files")}>
                <Feather name="folder" size={20} color={Colors.light.text} />
                <Text style={styles.sourceTileLabel}>Files</Text>
              </Pressable>
            </View>

            <Text style={styles.sourceHint}>
              Files covers iCloud, and Drive or Dropbox if you have their apps installed.
            </Text>

            {error && <Text style={styles.error}>{error}</Text>}

            {/* Extraction is an accelerator, never a dependency. On the auto-presenting
                version this lived on a screen the happy path never reached. */}
            <Pressable
              onPress={() => {
                tap();
                setPeriods([{ label: null, starts_on: null, ends_on: null, cash: "", product: "",
                              product_directed: null, conditional: false, condition: null, source_quote: null }]);
                setStep("review");
              }}
              hitSlop={8}
            >
              <Text style={styles.skipLink}>Enter the details by hand instead</Text>
            </Pressable>
          </ScrollView>
        )}

        {step === "working" && (
          <View style={styles.pickBody}>
            <ActivityIndicator color={Colors.light.primary} />
            <Text style={styles.workingNote}>{note}</Text>
          </View>
        )}

        {step === "destination" && (
          <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
            {filename && (
              <View style={styles.fileRow}>
                <Feather name="paperclip" size={13} color={Colors.light.textMuted} />
                <Text style={styles.fileName} numberOfLines={1}>{filename}</Text>
              </View>
            )}
            <View style={{ gap: 4 }}>
              <Text style={styles.destLead}>This mentions {brandFound?.name}.</Text>
              <Text style={styles.destSub}>
                We spotted the name — we haven&apos;t read the terms yet. Where should it live?
              </Text>
            </View>

            {realDeals.map((d) => (
              <Pressable
                key={d.id}
                style={styles.destOpt}
                onPress={() => choose({ kind: "existing", dealId: d.id })}
              >
                <BrandLogo brandName={d.brand_name ?? brandFound?.name ?? ""} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.destOptTitle}>{d.brand_name ?? brandFound?.name}</Text>
                  <Text style={styles.destOptSub}>{dealBlurb(d)}</Text>
                </View>
                <Feather name="chevron-right" size={16} color={Colors.light.textMuted} />
              </Pressable>
            ))}

            <Pressable style={styles.destOpt} onPress={() => choose({ kind: "fresh" })}>
              <BrandLogo brandName={brandFound?.name ?? ""} size={36} />
              <View style={{ flex: 1 }}>
                <Text style={styles.destOptTitle}>A new {brandFound?.name} deal</Text>
                <Text style={styles.destOptSub}>If this is a different agreement with them</Text>
              </View>
              <Feather name="chevron-right" size={16} color={Colors.light.textMuted} />
            </Pressable>

            <Pressable style={styles.destOpt} onPress={() => { tap(); setStep("chooseDeal"); }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.destOptTitle}>Something else</Text>
                <Text style={styles.destOptSub}>Pick another deal, or a new brand</Text>
              </View>
              <Feather name="chevron-right" size={16} color={Colors.light.textMuted} />
            </Pressable>

            <Text style={styles.destFoot}>Reading the contract takes about half a minute.</Text>
            {error && <Text style={styles.error}>{error}</Text>}
          </ScrollView>
        )}

        {step === "chooseDeal" && (
          <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
            <View style={{ gap: 4 }}>
              <Text style={styles.destLead}>
                {brandFound ? "Choose a deal" : "Whose contract is this?"}
              </Text>
              {!brandFound && (
                <Text style={styles.destSub}>We didn&apos;t spot a brand you already work with.</Text>
              )}
            </View>

            <TextInput
              style={styles.destSearch}
              value={query}
              onChangeText={setQuery}
              placeholder="Search your brands and deals"
              placeholderTextColor={Colors.light.textMuted}
              autoCorrect={false}
            />

            {searchResults.slice(0, 40).map((d) => (
              <Pressable
                key={d.id}
                style={styles.destOpt}
                onPress={() => choose({ kind: "existing", dealId: d.id })}
              >
                <BrandLogo brandName={d.brandName} brandDomain={d.brandDomain} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.destOptTitle}>{d.brandName}</Text>
                  <Text style={styles.destOptSub}>
                    {[d.offerAmount, d.status, d.timeAgo].filter(Boolean).join(" · ")}
                  </Text>
                </View>
              </Pressable>
            ))}

            {!q && allDeals.length > notableDeals.length && (
              <Text style={styles.destFoot}>
                {allDeals.length} deals in all — search to see everything
              </Text>
            )}
            {!!q && searchResults.length === 0 && (
              <Text style={styles.destFoot}>Nothing matches &ldquo;{query}&rdquo; yet.</Text>
            )}

            {/* Always last, always present: a brand genuinely new to her costs no extra screen. */}
            <Pressable style={styles.destOpt} onPress={() => choose({ kind: "fresh" })}>
              <View style={styles.destPlus}>
                <Feather name="plus" size={15} color={Colors.light.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.destOptTitle}>
                  {q ? `Start a new deal with "${query.trim()}"` : "Start a new deal"}
                </Text>
                <Text style={styles.destOptSub}>For a brand you haven&apos;t worked with yet</Text>
              </View>
            </Pressable>
            {error && <Text style={styles.error}>{error}</Text>}
          </ScrollView>
        )}
        {step === "brandPick" && (
          <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
            <View style={{ gap: 4 }}>
              <Text style={styles.destLead}>Which brand?</Text>
              {!!contractBrand && (
                <Text style={styles.destSub}>
                  The contract is signed with <Text style={styles.destStrong}>{contractBrand}</Text>.
                </Text>
              )}
            </View>

            <TextInput
              style={styles.destSearch}
              value={brandQuery}
              onChangeText={(v) => { setBrandQuery(v); void searchBrands(v); }}
              placeholder="Search your brands"
              placeholderTextColor={Colors.light.textMuted}
              autoCorrect={false}
            />

            {/* Suggested, never applied. Trigram similarity scores adidas against
                "adidas America" at 1.0, and also pairs `ccsu edu` with `sjsu edu` — good
                enough to rank an answer, nowhere near good enough to choose one. */}
            {brandOptions.map((b) => (
              <Pressable
                key={b.brand_id}
                style={styles.destOpt}
                onPress={() => { tap(); setBrandName(b.name ?? ""); setStep("review"); }}
              >
                <BrandLogo brandName={b.name ?? ""} brandDomain={b.domain} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.destOptTitle}>{b.name}</Text>
                  <Text style={styles.destOptSub}>You already work with them</Text>
                </View>
              </Pressable>
            ))}

            {!brandSearching && brandOptions.length === 0 && (
              <Text style={styles.destFoot}>
                None of your brands match. Adding it as new is the right answer if you
                haven&apos;t worked with them before.
              </Text>
            )}

            {/* The name is editable here because a legal signatory is a bad brand name,
                and this is the last chance to fix it before a row is created. */}
            <View style={styles.newBrandBox}>
              <Text style={styles.brandFieldLabel}>Add as a new brand</Text>
              <TextInput
                style={styles.destSearch}
                value={brandQuery}
                onChangeText={setBrandQuery}
                placeholder="adidas"
                placeholderTextColor={Colors.light.textMuted}
                autoCorrect={false}
              />
              <Pressable
                onPress={() => {
                  if (!brandQuery.trim()) return;
                  tap(); setBrandName(brandQuery.trim()); setStep("review");
                }}
                style={[styles.primaryBtn, !brandQuery.trim() && { opacity: 0.4 }]}
              >
                <Text style={styles.primaryBtnText}>
                  {brandQuery.trim() ? `Add "${brandQuery.trim()}"` : "Name the brand"}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        )}
        {step === "review" && (
          <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
            {changeRows.length > 0 && (
              <View style={styles.changeBox}>
                <Text style={styles.changeTitle}>This replaces what your emails suggested</Text>
                {changeRows.map((r) => (
                  <View key={r.key} style={styles.changeRow}>
                    <Text style={styles.changeKey}>{r.key}</Text>
                    {r.changed && r.was != null && (
                      <Text style={styles.changeWas}>{r.was}</Text>
                    )}
                    <Text style={[styles.changeNow, !r.changed && styles.changeSame]}>{r.now}</Text>
                    {r.changed && r.was == null && <Text style={styles.changeAdded}>added</Text>}
                  </View>
                ))}
                <Text style={styles.changeFoot}>
                  The old figures are kept in this deal&apos;s history.
                </Text>
              </View>
            )}
            {note && (
              <View style={styles.noteBox}>
                <Feather name="info" size={13} color={Colors.light.textSecondary} />
                <Text style={styles.noteText}>{note}</Text>
              </View>
            )}
            {filename && (
              <View style={styles.fileRow}>
                <Feather name="paperclip" size={13} color={Colors.light.textMuted} />
                <Text style={styles.fileName} numberOfLines={1}>{filename}</Text>
              </View>
            )}

            {/* WHAT THE CONTRACT SAYS, before what she confirms.
                A form that is entirely pre-filled and correct-looking gets rubber-stamped,
                which turns the review step into a laundering step for model output. So the
                schedule is shown as the document's own rows — including the years that are
                conditional and the credit she never receives — and the fields below are the
                small set that actually reaches the deal. */}
            {(divergent.length > 0 || charitable != null || exclusivity !== false) && (
              <View style={styles.schedule}>
                <Text style={styles.scheduleTitle}>From the contract</Text>
                {divergent.length > 0 && (
                  <Text style={styles.unstableNote}>
                    {"We read this twice and got different answers for: " + divergent.join(", ") +
                     ". Those are left out below — check them against the contract."}
                  </Text>
                )}
                {charitable != null && (
                  <Text style={styles.scheduleNote}>
                    {"$" + Number(charitable).toLocaleString() + "/yr charitable credit \u2014 you choose where it goes, so it is not part of what you are paid."}
                  </Text>
                )}
                {exclusivity === true && (
                  <Text style={styles.exclusivityNote}>
                    This contract limits who else you can work with. Worth reading before
                    you agree to anything in the same category.
                  </Text>
                )}
                {exclusivity === null && (
                  <Text style={styles.scheduleNote}>
                    We could not tell whether this contract has an exclusivity clause — check
                    the document before relying on it.
                  </Text>
                )}
                {/* Her confirmation, not the model's reading, is what Nomila respects as a bound. */}
                <Text style={styles.scheduleNote}>Is this contract exclusive?</Text>
                <View style={styles.confirmRow}>
                  {([["Yes", true], ["No", false], ["Not sure", null]] as const).map(([label, value]) => (
                    <Pressable
                      key={label}
                      accessibilityRole="button"
                      accessibilityState={{ selected: exclusivityConfirmed === value }}
                      onPress={() => setExclusivityConfirmed(value)}
                      style={[styles.confirmPill, exclusivityConfirmed === value && styles.confirmPillOn]}
                    >
                      <Text style={[styles.confirmPillText, exclusivityConfirmed === value && styles.confirmPillTextOn]}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

            {/* A field she TAPS, not one she types into.

                Typed free, it carried whatever the contract called the signatory —
                "adidas America, Inc." — straight into resolveBrand, which creates on a
                miss. That mints a brand under a name nobody uses, and the first email
                from the brand then mints a second under the name everyone does. */}
            {/* Only when a brand is actually being decided. Attaching to a deal she
                already has inherits its brand — POST /deals/:id/contract does not read
                one — so an editable Brand field there would be a control that does
                nothing, on the screen where she is checking what is true. */}
            {destination?.kind !== "existing" && (
            <Pressable onPress={openBrandPick} style={styles.brandField}>
              <View style={{ flex: 1 }}>
                <Text style={styles.brandFieldLabel}>Brand</Text>
                <Text style={[styles.brandFieldValue, !brandName && styles.brandFieldEmpty]}>
                  {brandName || "Choose a brand"}
                </Text>
                {!!contractBrand && contractBrand !== brandName && (
                  <Text style={styles.brandFieldNote}>
                    The contract says &ldquo;{contractBrand}&rdquo;
                  </Text>
                )}
              </View>
              <Feather name="chevron-right" size={16} color={Colors.light.textMuted} />
            </Pressable>
            )}

            {/* THE SCHEDULE IS THE FORM. One row for a single-term deal, several for a
                multi-year contract — the same control either way, and the rows she edits
                are the rows that get saved. */}
            <View style={styles.sched}>
              <View style={styles.schedHead}>
                <Text style={[styles.schedCol, { flex: 1 }]}>Period</Text>
                <Text style={styles.schedCol}>Cash</Text>
                <Text style={styles.schedCol}>Product</Text>
              </View>
              {periods.map((row, i) => (
                <View key={i} style={styles.periodRow}>
                  <View style={{ flex: 1, paddingRight: Spacing.sm }}>
                    <Text style={styles.periodLabel} numberOfLines={1}>
                      {row.label ?? (periods.length > 1 ? `Period ${i + 1}` : "The deal")}
                    </Text>
                    {row.conditional && (
                      <Text style={styles.periodCond} numberOfLines={1}>
                        {row.condition ? "only if: " + row.condition.slice(0, 40) : "conditional"}
                      </Text>
                    )}
                  </View>
                  <TextInput
                    style={styles.cell}
                    value={row.cash}
                    onChangeText={(v) => setPeriods((ps) => ps.map((r, j) => (j === i ? { ...r, cash: v } : r)))}
                    placeholder="—"
                    placeholderTextColor={Colors.light.textMuted}
                    keyboardType="numeric"
                  />
                  <TextInput
                    style={styles.cell}
                    value={row.product}
                    onChangeText={(v) => setPeriods((ps) => ps.map((r, j) => (j === i ? { ...r, product: v } : r)))}
                    placeholder="—"
                    placeholderTextColor={Colors.light.textMuted}
                    keyboardType="numeric"
                  />
                </View>
              ))}
            </View>

            <View style={styles.row}>
              <View style={styles.rowItem}>
                <Field label="Starts" value={termStart} onChange={setTermStart} placeholder="2023-01-01" />
              </View>
              <View style={styles.rowItem}>
                <Field label="Ends" value={termEnd} onChange={setTermEnd} placeholder="2028-12-31" />
              </View>
            </View>

            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Already signed</Text>
                <Text style={styles.hint}>Signed deals count toward your score.</Text>
              </View>
              <Switch
                value={signed}
                onValueChange={(v) => { tap(); setSigned(v); }}
                trackColor={{ true: Colors.light.primary, false: Colors.light.border }}
              />
            </View>

            {error && <Text style={styles.error}>{error}</Text>}

            {/* Last thing before she commits: the figures, named. Derived from the fields
                above, so a correction she just made is reflected here rather than in the
                model's original numbers. */}
            {summaryRows.length > 0 && (
              <View style={styles.summary}>
                {summaryRows.map((row) => (
                  <View key={row.abbr} style={styles.summaryRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.summaryAbbr}>{row.abbr}</Text>
                      <Text style={styles.summaryName}>{row.name}</Text>
                    </View>
                    <Text style={styles.summaryValue}>{row.value}</Text>
                  </View>
                ))}
              </View>
            )}

            <Pressable style={styles.primaryBtn} onPress={save}>
              <Text style={styles.primaryBtnText}>Save deal</Text>
            </Pressable>
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Field({
  label, value, onChange, placeholder, numeric, autoFocus,
}: {
  label: string; value: string; onChange: (s: string) => void;
  placeholder?: string; numeric?: boolean; autoFocus?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={Colors.light.textMuted}
        keyboardType={numeric ? "numeric" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.light.border,
  },
  cancel: { fontFamily: Fonts.body, fontSize: 15, color: Colors.light.textSecondary, width: 52 },
  title:  { fontFamily: Fonts.headingSemiBold, fontSize: 16, color: Colors.light.text },

  pickBody: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xl, gap: Spacing.md },
  pickIcon: {
    width: 56, height: 56, borderRadius: BorderRadius.sm, alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.light.primaryLight, marginBottom: Spacing.xs,
  },
  pickTitle: { fontFamily: Fonts.heading, fontSize: 19, color: Colors.light.text },
  pickBlurb: {
    fontFamily: Fonts.body, fontSize: 14, lineHeight: 20, color: Colors.light.textSecondary,
    textAlign: "center", maxWidth: 300,
  },
  workingNote: { fontFamily: Fonts.body, fontSize: 14, color: Colors.light.textSecondary, marginTop: Spacing.md },
  skipLink: { fontFamily: Fonts.bodyMedium, fontSize: 13, color: Colors.light.textMuted, marginTop: Spacing.xs },

  changeBox: {
    backgroundColor: "#FDF3DC", borderWidth: 1, borderColor: "#E8D5A8",
    borderRadius: 12, padding: Spacing.md, gap: 2,
  },
  changeTitle: {
    fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: "#7A5200", marginBottom: 4,
  },
  changeRow: {
    flexDirection: "row", alignItems: "baseline", gap: Spacing.sm,
    paddingVertical: 5, borderTopWidth: 1, borderTopColor: "rgba(180,83,9,0.12)",
  },
  changeKey:   { flex: 1, fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: "#5C3D00" },
  changeWas:   { fontFamily: Fonts.body, fontSize: 12, color: "#9A7B3C", textDecorationLine: "line-through" },
  changeNow:   { fontFamily: Fonts.bodyMedium, fontSize: 13, color: "#5C3D00" },
  // A figure the contract CONFIRMS is not a change, and must not read as one.
  changeSame:  { fontFamily: Fonts.body, color: "#9A7B3C" },
  changeAdded: { fontFamily: Fonts.bodyMedium, fontSize: 10, color: "#1A9960" },
  changeFoot:  { fontFamily: Fonts.body, fontSize: 10.5, color: "#9A7B3C", marginTop: 6 },
  brandField: {
    flexDirection: "row", alignItems: "center", gap: Spacing.sm,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 12, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
  },
  brandFieldLabel: { fontFamily: Fonts.bodyMedium, fontSize: 11, color: Colors.light.textMuted, letterSpacing: 0.3 },
  brandFieldValue: { fontFamily: Fonts.bodyMedium, fontSize: 15, color: Colors.light.text, marginTop: 2 },
  brandFieldEmpty: { fontFamily: Fonts.body, color: Colors.light.textMuted },
  brandFieldNote:  { fontFamily: Fonts.body, fontSize: 11, color: Colors.light.textMuted, marginTop: 3 },
  destStrong: { fontFamily: Fonts.bodyMedium, color: Colors.light.text },
  newBrandBox: {
    gap: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.light.border,
    paddingTop: Spacing.lg,
  },
  sourceRow: { flexDirection: "row", gap: Spacing.sm },
  sourceTile: {
    flex: 1, aspectRatio: 1.15, alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 14,
  },
  sourceTileLabel: { fontFamily: Fonts.bodyMedium, fontSize: 13.5, color: Colors.light.text },
  sourceHint: { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16, color: Colors.light.textMuted },
  destLead: { fontFamily: Fonts.heading, fontSize: 20, color: Colors.light.text },
  destSub:  { fontFamily: Fonts.body, fontSize: 14, lineHeight: 19, color: Colors.light.textSecondary },
  destOpt: {
    flexDirection: "row", alignItems: "center", gap: Spacing.sm,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 12, padding: Spacing.md,
  },
  destOptTitle: { fontFamily: Fonts.bodyMedium, fontSize: 14.5, color: Colors.light.text },
  destOptSub:   { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted, marginTop: 2 },
  destFoot:     { fontFamily: Fonts.body, fontSize: 11.5, color: Colors.light.textMuted },
  destSearch: {
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 22, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    fontFamily: Fonts.body, fontSize: 14, color: Colors.light.text,
  },
  destPlus: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.light.primaryLight,
    alignItems: "center", justifyContent: "center",
  },
  form: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing["2xl"] * 2 },
  noteBox: {
    flexDirection: "row", gap: Spacing.sm, alignItems: "flex-start",
    backgroundColor: Colors.light.backgroundSecondary, padding: Spacing.md, borderRadius: BorderRadius.xs,
  },
  noteText: { flex: 1, fontFamily: Fonts.body, fontSize: 13, lineHeight: 18, color: Colors.light.textSecondary },
  fileRow:  { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
  fileName: { flex: 1, fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted },

  schedule: {
    backgroundColor: Colors.light.card, borderRadius: BorderRadius.xs,
    borderWidth: 1, borderColor: Colors.light.border, padding: Spacing.md, gap: Spacing.xs,
  },
  scheduleTitle: { fontFamily: Fonts.bodyMedium, fontSize: 13, color: Colors.light.text, marginBottom: 2 },
  scheduleRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  schedulePeriod: { flex: 1, fontFamily: Fonts.body, fontSize: 13, color: Colors.light.textSecondary },
  scheduleAmount: { fontFamily: Fonts.bodyMedium, fontSize: 13, color: Colors.light.text },
  conditionalTag: {
    fontFamily: Fonts.body, fontSize: 10, color: Colors.light.textMuted,
    borderWidth: 1, borderColor: Colors.light.border, borderRadius: 3,
    paddingHorizontal: 4, paddingVertical: 1,
  },
  unstableNote: {
    fontFamily: Fonts.bodyMedium, fontSize: 12, lineHeight: 17, color: Colors.light.error,
    marginBottom: Spacing.xs,
  },
  scheduleNote: {
    fontFamily: Fonts.body, fontSize: 12, lineHeight: 17, color: Colors.light.textMuted, marginTop: Spacing.xs,
  },
  confirmRow: { flexDirection: "row", gap: 8, marginTop: 6 },
  confirmPill: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,255,255,0.25)" },
  confirmPillOn: { backgroundColor: "rgba(255,255,255,0.9)", borderColor: "rgba(255,255,255,0.9)" },
  confirmPillText: { color: "rgba(255,255,255,0.85)", fontSize: 13 },
  confirmPillTextOn: { color: "#0B0B0F", fontWeight: "600" },
  exclusivityNote: {
    fontFamily: Fonts.bodyMedium, fontSize: 12, lineHeight: 17, color: Colors.light.text, marginTop: Spacing.xs,
  },
  sched: {
    backgroundColor: Colors.light.card, borderRadius: BorderRadius.xs,
    borderWidth: 1, borderColor: Colors.light.border, paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.xs,
  },
  schedHead: { flexDirection: "row", alignItems: "center", paddingTop: Spacing.sm, paddingBottom: 4 },
  schedCol: {
    fontFamily: Fonts.bodyMedium, fontSize: 9.5, letterSpacing: 0.6,
    textTransform: "uppercase", color: Colors.light.textMuted, width: 74, textAlign: "right",
  },
  periodRow: {
    flexDirection: "row", alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.light.border,
    paddingVertical: Spacing.xs,
  },
  periodLabel: { fontFamily: Fonts.body, fontSize: 12.5, color: Colors.light.text },
  periodCond: { fontFamily: Fonts.body, fontSize: 10, color: Colors.light.textMuted, marginTop: 1 },
  cell: {
    width: 74, textAlign: "right", fontFamily: Fonts.bodyMedium, fontSize: 13,
    color: Colors.light.text, paddingVertical: 4, paddingHorizontal: 6,
    borderWidth: 1, borderColor: Colors.light.border, borderRadius: 5,
    marginLeft: Spacing.xs, backgroundColor: Colors.light.backgroundRoot,
  },
  summary: {
    backgroundColor: Colors.light.card, borderRadius: BorderRadius.xs,
    borderWidth: 1, borderColor: Colors.light.border, paddingHorizontal: Spacing.md,
  },
  summaryRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: Spacing.sm },
  summaryAbbr: { fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: Colors.light.text, letterSpacing: 0.4 },
  summaryName: { fontFamily: Fonts.body, fontSize: 10.5, color: Colors.light.textMuted, marginTop: 1 },
  summaryValue: { fontFamily: Fonts.bodyMedium, fontSize: 15, color: Colors.light.text, fontVariant: ["tabular-nums"] },
  field: { gap: Spacing.xs },
  label: { fontFamily: Fonts.bodyMedium, fontSize: 13, color: Colors.light.text },
  hint:  { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted, marginTop: 2 },
  input: {
    borderWidth: 1, borderColor: Colors.light.border, borderRadius: BorderRadius.xs,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    fontFamily: Fonts.body, fontSize: 15, color: Colors.light.text, backgroundColor: Colors.light.card,
  },
  row:     { flexDirection: "row", gap: Spacing.md },
  rowItem: { flex: 1 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md },

  primaryBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Spacing.sm,
    backgroundColor: Colors.light.primary,
    // Horizontal padding was missing entirely, so the label ran flush to the button's
    // edges and overflowed it on anything longer than "Save".
    paddingVertical: Spacing.lg, paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.xs, marginTop: Spacing.xs,
  },
  primaryBtnText: {
    fontFamily: Fonts.headingSemiBold, fontSize: 15, color: "#FFFFFF",
    flexShrink: 1, textAlign: "center",
  },
  error: { fontFamily: Fonts.body, fontSize: 13, color: Colors.light.error, textAlign: "center" },
});
