import { runsBackgroundWork } from "./backgroundHost";

describe("runsBackgroundWork", () => {
  it("runs on Cloud Run", () => {
    expect(runsBackgroundWork({ K_SERVICE: "nomila-v2", NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
  });
  it("runs in tests", () => {
    expect(runsBackgroundWork({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(true);
  });
  it("does not run on a local server against the shared database", () => {
    expect(runsBackgroundWork({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("runs locally only when a developer opts in", () => {
    expect(runsBackgroundWork({ NODE_ENV: "development", LOCAL_BACKGROUND_WORK: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(runsBackgroundWork({ NODE_ENV: "development", LOCAL_BACKGROUND_WORK: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
