import { isFooterOnly } from "../../shared/emailFooter";

const NOTICE = "This e-mail or any attachments may contain confidential or privileged information. Unless you are the intended recipient, you may not disclose, copy or use any information herein. If you have received this e-mail in error, please notify the sender immediately by reply and delete the e-mail from your system.";

it("a message that is only a legal notice (with or without a short sign-off) is footer-only", () => {
  expect(isFooterOnly(NOTICE)).toBe(true);
  expect(isFooterOnly(`Regards,\n\n${NOTICE}`)).toBe(true);
  expect(isFooterOnly(`-----\n${NOTICE}\n-----`)).toBe(true);
});

it("a real message that ends with the same notice is not footer-only", () => {
  expect(isFooterOnly(`Hi, we'd love to work with you on a spring campaign: two posts and a story. Are you open to a call this week?\n\n${NOTICE}`)).toBe(false);
  expect(isFooterOnly(`Please find attached the remittance for invoice 4471, paid today by bank transfer.\n${NOTICE}`)).toBe(false);
});

it("text with no notice wording, or no text, is not footer-only", () => {
  expect(isFooterOnly("Thanks!")).toBe(false);
  expect(isFooterOnly("")).toBe(false);
  expect(isFooterOnly(null)).toBe(false);
});
