/**
 * deletionCompleteEmail.ts — the "your account is deleted" email, sent once by the account_deletion run's finish step
 * when every clean-up is verified (Apple: "provide a confirmation when the deletion is complete"). Through the one
 * transactional sender (lib/notify.ts sendEmail); with EMAIL_PROVIDER off it logs and sends nothing.
 *
 * No name and nothing about them: by now Nomila holds nothing else. The reference is the receipt id the app showed.
 */
import { sendEmail } from "../notify";

export const DELETION_COMPLETE_SUBJECT = "Your Nomila account is deleted";

/** The receipt id as the app shows it: first 4 and last 4 characters. */
export const shortReference = (receiptId: string): string =>
  receiptId.length > 10 ? `${receiptId.slice(0, 4)}…${receiptId.slice(-4)}` : receiptId;

export function deletionCompleteEmail(receiptId: string): { subject: string; text: string; html: string } {
  const ref = shortReference(receiptId);
  const lines = [
    "Your Nomila account is deleted.",
    "We've erased your data and disconnected the accounts you linked. Backups clear within 7 days.",
    "We keep a record of money that moved through Nomila, with nothing that names you, for tax and accounting.",
    `Reference: ${receiptId}. If you didn't ask for this, write to us at hello@nomila.co.`,
  ];
  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#F3F3F1;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:40px 24px;color:#0E0E0E;">
      <div style="font-weight:900;font-size:13px;letter-spacing:0.34em;">NOMILA</div>
      <h1 style="font-size:24px;font-weight:900;text-transform:uppercase;letter-spacing:-0.4px;margin:28px 0 12px;">Your account is deleted</h1>
      <p style="font-size:15px;line-height:1.5;color:#3A3A3A;margin:0 0 12px;">${lines[1]}</p>
      <p style="font-size:15px;line-height:1.5;color:#3A3A3A;margin:0 0 24px;">${lines[2]}</p>
      <p style="font-size:13px;line-height:1.5;color:#6B6B6B;margin:0;">Reference: ${ref}. If you didn't ask for this, write to us at hello@nomila.co.</p>
    </div>
  </body>
</html>`;
  return { subject: DELETION_COMPLETE_SUBJECT, text: lines.join("\n\n"), html };
}

export async function sendDeletionCompleteEmail(to: string, receiptId: string): Promise<{ sent: boolean }> {
  const r = await sendEmail({ to, ...deletionCompleteEmail(receiptId) });
  return { sent: r.sent };
}
