/**
 * disposableDomains.ts — a bundled list of common disposable / throwaway e-mail domains, for the `disposable_email`
 * admin flag (lib/signupFlags.ts). A signal for a human reviewer, never a block: nothing is refused for being on it.
 * Lower case; a sub-domain of a listed domain matches too (isDisposableEmail).
 */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "10minutemail.com", "10minutemail.net", "10minutemail.co.uk", "20minutemail.com", "33mail.com", "anonaddy.me",
  "burnermail.io", "byom.de", "chacuo.net", "cock.li", "crazymailing.com", "deadaddress.com", "discard.email",
  "discardmail.com", "dispostable.com", "dropmail.me", "emailondeck.com", "emailfake.com", "emailtemporanea.net",
  "emltmp.com", "fakeinbox.com", "fakemail.net", "fakemailgenerator.com", "fexbox.org", "getairmail.com",
  "getnada.com", "guerrillamail.biz", "guerrillamail.com", "guerrillamail.de", "guerrillamail.info",
  "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com", "grr.la", "harakirimail.com", "inboxbear.com",
  "inboxkitten.com", "incognitomail.org", "jetable.org", "kurzepost.de", "linshiyouxiang.net", "mail-temp.com",
  "mail.tm", "mail7.io", "mailcatch.com", "maildrop.cc", "mailinator.com", "mailinator.net", "mailinator2.com",
  "mailnesia.com", "mailpoof.com", "mailsac.com", "mailtemp.net", "mailtothis.com", "meltmail.com", "mintemail.com",
  "moakt.com", "mohmal.com", "mvrht.com", "mytemp.email", "mytrashmail.com", "nada.email", "nwytg.net",
  "one-time.email", "oneoffemail.com", "owlymail.com", "pokemail.net", "proxymail.eu", "rcpt.at", "sharklasers.com",
  "spam4.me", "spambog.com", "spambox.us", "spamgourmet.com", "spamex.com", "spamfree24.org", "spaml.de",
  "spamobox.com", "spoofmail.de", "tafmail.com", "temp-mail.io", "temp-mail.org", "tempail.com", "tempemail.co",
  "tempinbox.com", "tempmail.com", "tempmail.dev", "tempmail.net", "tempmail.plus", "tempmailo.com", "tempr.email",
  "tempsky.com", "throwam.com", "throwawaymail.com", "tmail.ws", "tmailor.com", "tmpmail.net", "tmpmail.org",
  "tmpeml.com", "trash-mail.com", "trashmail.com", "trashmail.de", "trashmail.io", "trashmail.me", "trashmail.net",
  "trbvm.com", "wegwerfmail.de", "wegwerfmail.net", "yopmail.com", "yopmail.fr", "yopmail.net", "zetmail.com",
  "mailnull.com", "spamherelots.com", "tempmailaddress.com", "emailnax.com", "mailbox.in.ua", "luxusmail.org",
  "minuteinbox.com", "fakermail.com", "vomoto.com", "xojxe.com", "laafd.com", "qiott.com", "kzccv.com", "bupmail.com",
  "eelmail.com", "dcctb.com", "cyclelove.cc", "wuuvo.com", "dropjar.com", "anonbox.net", "secretmail.net",
]);

/** True when the e-mail's domain (or a parent domain of it) is on the bundled list. */
export function isDisposableEmail(email: string | null | undefined): boolean {
  const at = (email ?? "").lastIndexOf("@");
  if (at < 0) return false;
  const parts = email!.slice(at + 1).trim().toLowerCase().replace(/\.$/, "").split(".");
  for (let i = 0; i < parts.length - 1; i++) if (DISPOSABLE_DOMAINS.has(parts.slice(i).join("."))) return true;
  return false;
}
