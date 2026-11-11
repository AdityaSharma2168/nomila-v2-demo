/**
 * agent/documents/prompts.ts — each documents tool's description, as the model reads it. Registered verbatim in the
 * Prompt Register ("Mila documents toolset", Mila & agent area); a change here is a change there. The area's rules are
 * the documents playbook (mila/skills/documents/SKILL.md), which replaced the toolset preamble on 3 Nov 2026. The guard
 * test (tools.test.ts) checks each tool has a description with "Use" and "Don't use", the playbook names every tool,
 * and the chat skill lists every tool.
 */

export const DOCUMENTS_TOOLSET_ID = "documents";

export const DOCUMENTS_STATUS_DESCRIPTION =
  "Where their documents stand: the brand book, the public page and each pitch — built or not, building, last updated, shared and opened, published — plus brands a pitch could be made for now. With detail: pages, one document's pages and the lines that can change (each line's slot, its text and its stored options). Free. Shows a card for each document it reports. " +
  "document: all | brand_book | public_page | pitch (pitch needs brand: part of the brand's name). " +
  "Use for \"what documents do I have?\", \"is my pitch for <brand> ready?\", and before documents_edit (detail: pages). " +
  "Don't use for their M.I.A., deals or goals, and don't ask for pages just to answer a status question.";

export const DOCUMENTS_MAKE_DESCRIPTION =
  "Build or rebuild one whole document in the background: a pitch for one of their brands, the public page, or the brand book. Shows a progress card; they can leave, and you come back in this chat when it's ready. Nothing goes out. Costs Nomila about 20 cents for a pitch or the public page, a few cents for the brand book; a document already building is joined, never paid twice. " +
  "document: brand_book | public_page | pitch (pitch needs brand). angles: up to 3 angles they want the pitch to lead with, in their words (pitch only). " +
  "Use when they ask for a new pitch (\"make me a pitch for <brand>\"), a fresh one, or to rewrite the brand book. " +
  "Don't use to change one line or photo (documents_edit), to share (documents_share), or for a brand the result says isn't confirmed or researched. " +
  "Errors: brand_not_confirmed, no_research, not_found (not one of their brands), daily_limit, feature_off — each says what to do next.";

export const DOCUMENTS_EDIT_DESCRIPTION =
  "Change one thing on a private document, saved at once (nothing goes out, free): pick_line (another stored option for a line: option is its index from documents_status pages), write_line (new words you write for a line: text, under 240 characters), next_photo (the next-best of their own photos on that page; not for the brand book). " +
  "document: brand_book | public_page | pitch (pitch needs brand); page and slot from documents_status with detail: pages. " +
  "Use when they ask to change a line, the tone of a line, or a photo. Prefer pick_line when a stored option already says what they want. " +
  "Don't use to rewrite a whole document (documents_make). A written line uses only what the page, CONTEXT or they say: never a new fact, number or partner. " +
  "Example: \"make the cover of my pitch warmer\" → documents_status (pitch, brand, detail: pages), then documents_edit write_line on the cover's line — not documents_make.";

export const DOCUMENTS_SHARE_DESCRIPTION =
  "Get a document ready to go out, for their tap: a live link to their pitch for one brand (document: pitch, brand), or publishing their public page (document: public_page). NOT done by this call: they see a card with Approve and Not now, and it happens only if they tap. Free. " +
  "Use when they ask to share, send or publish. Example: \"send my pitch to <brand>\" → documents_share (pitch, brand); you never email the brand yourself. " +
  "Don't use on your own initiative, for the brand book (it is private), or for a pitch that isn't built yet (documents_make first). After it, say it's waiting for their tap.";
