// notify/templates — the shared transactional email templates. render.ts (the generic helper), send.ts (render +
// the existing email channel, "would send" with no provider), and one file of templates per track (bookings.ts, partner.ts).
export { renderTemplate, type EmailTemplate, type TemplateVars, type RenderedEmail } from "./render";
export { sendTemplate, emailProviderConfigured, type TemplateSendResult } from "./send";
export { PARTNER_TEMPLATES } from "./partner";
export { WAITLIST_TEMPLATES, waitlistPageUrl, scoreEmailEnabled } from "./waitlist";
