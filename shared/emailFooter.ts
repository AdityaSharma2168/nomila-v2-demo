/**
 * emailFooter — is a message's text only a confidentiality / legal footer?
 *
 * Some company mail carries everything in an attachment (an invoice, a payment advice, a brief) and its email text is
 * only the legal notice ("This e-mail may contain confidential or privileged information…"). Shown as the message,
 * that notice reads as if it were the content. Generic: judged sentence by sentence on legal-notice wording, never on
 * a sender or a brand. Pure; shared by the server (the thread route marks such messages) and its tests.
 */

const NOTICE = /\b(confidential|privileged|intended (recipient|solely|only)|received (this|the) (e-?mail|message|communication) in error|notify the sender|delete (it|this|the (e-?mail|message))|(disclos|copy|distribut|dissemina)\w* (of )?(this|any|the)|unauthori[sz]ed|legally protected|virus(es)?|do not (reply|respond) to this|this (is an )?automated (message|e-?mail)|printing this e-?mail|environment before)\b/i;

/** The text's sentences that are not legal-notice boilerplate, joined. */
function substance(text: string): string {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s && !NOTICE.test(s) && !/^[-_=*~\s]+$/.test(s))
    .join(" ");
}

/** True when the text has some legal-notice wording and nothing else of substance (a sign-off at most). */
export function isFooterOnly(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  if (!t || !NOTICE.test(t)) return false;
  return substance(t).replace(/[^\p{L}\p{N}]+/gu, "").length < 25;
}
