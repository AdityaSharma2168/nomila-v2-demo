/**
 * notify.provider.test — Gmail is the only email provider. EMAIL_PROVIDER=gmail sends through the Gmail sender (stood
 * in here — its own suite covers the Google endpoints); unset, "off" or anything else delivers nothing and makes no
 * network call. No network: global fetch is a jest.fn that must never be called.
 */
jest.mock("../db", () => ({ db: {} }));
jest.mock("../logger", () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
const gmailSend = jest.fn(async (_m: unknown) => ({ sent: true, id: "gmail-1" }));
jest.mock("./gmailSender", () => ({ getGmailSender: () => ({ send: gmailSend }) }));

delete process.env.NOTIFY_FROM_EMAIL;

import { emailProvider, emailProviderConfigured, isProdDeployment, sendEmail } from "./notify";

const fetchMock = jest.fn(async (_u: any, _i?: any) => new Response("{}", { status: 200 }));
const realFetch = global.fetch;
beforeAll(() => { global.fetch = fetchMock as any; });
afterAll(() => { global.fetch = realFetch; delete process.env.EMAIL_PROVIDER; });
beforeEach(() => { fetchMock.mockClear(); gmailSend.mockClear(); delete process.env.EMAIL_PROVIDER; });

const MSG = { to: "a@example.com", subject: "s", html: "<p>h</p>", text: "h", replyTo: "partners+t@nomila.co" };

test("EMAIL_PROVIDER=gmail → Gmail sender, From = NOTIFY_FROM_EMAIL default, Reply-To passed through", async () => {
  process.env.EMAIL_PROVIDER = "gmail";
  expect(await sendEmail(MSG)).toEqual({ sent: true, id: "gmail-1" });
  expect(gmailSend).toHaveBeenCalledWith({ from: "Nomila <hello@nomila.co>", ...MSG });
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([[undefined], ["off"], ["resend"], ["sendgrid"]])("EMAIL_PROVIDER=%s → nothing delivered, no network call", async (value) => {
  if (value !== undefined) process.env.EMAIL_PROVIDER = value;
  expect(await sendEmail(MSG)).toEqual({ sent: false, skipped: true });
  expect(gmailSend).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(emailProvider()).toBe("off");
  expect(emailProviderConfigured()).toBe(false);
});

test("emailProviderConfigured: gmail is keyless, so selecting it counts as configured", () => {
  process.env.EMAIL_PROVIDER = "gmail";
  expect(emailProviderConfigured()).toBe(true);
});

describe("dev test sign-ups are never mailed outside prod", () => {
  const saved = { k: process.env.K_SERVICE, api: process.env.API_BASE_URL };
  afterEach(() => {
    if (saved.k === undefined) delete process.env.K_SERVICE; else process.env.K_SERVICE = saved.k;
    if (saved.api === undefined) delete process.env.API_BASE_URL; else process.env.API_BASE_URL = saved.api;
  });
  const TEST = { ...MSG, to: "signup-test+journey-20261106@nomila.co" };

  test("on dev (and locally) a signup-test+ address is skipped: no Gmail call", async () => {
    process.env.EMAIL_PROVIDER = "gmail";
    process.env.K_SERVICE = "nomila-v2";
    process.env.API_BASE_URL = "https://api-dev.nomila.co";
    expect(await sendEmail(TEST)).toEqual({ sent: false, skipped: true });
    expect(await sendEmail({ ...TEST, to: "Signup-Test+x@Nomila.co" })).toEqual({ sent: false, skipped: true });
    delete process.env.K_SERVICE;
    delete process.env.API_BASE_URL;
    expect(await sendEmail(TEST)).toEqual({ sent: false, skipped: true });
    expect(gmailSend).not.toHaveBeenCalled();
  });

  test("other addresses on dev still send; look-alikes are not test addresses", async () => {
    process.env.EMAIL_PROVIDER = "gmail";
    process.env.K_SERVICE = "nomila-v2";
    for (const to of ["a@example.com", "signup-test@nomila.co", "signup-test+x@nomila.co.evil.com", "xsignup-test+x@nomila.co"]) {
      expect(await sendEmail({ ...MSG, to })).toEqual({ sent: true, id: "gmail-1" });
    }
    expect(gmailSend).toHaveBeenCalledTimes(4);
  });

  test("prod is unchanged: a signup-test+ address is sent there", async () => {
    process.env.EMAIL_PROVIDER = "gmail";
    for (const env of [{ K_SERVICE: "nomila-v2-prod" }, { API_BASE_URL: "https://api.nomila.co/" }]) {
      delete process.env.K_SERVICE; delete process.env.API_BASE_URL;
      Object.assign(process.env, env);
      expect(isProdDeployment()).toBe(true);
      expect(await sendEmail(TEST)).toEqual({ sent: true, id: "gmail-1" });
    }
    expect(gmailSend).toHaveBeenCalledTimes(2);
  });
});
