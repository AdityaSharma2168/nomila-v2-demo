import { withTimeout } from "./withTimeout";

describe("withTimeout", () => {
  it("resolves when the inner promise beats the timeout", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50, "fast")).resolves.toBe("ok");
  });

  it("rejects with a labeled error when the inner promise outlives the timeout", async () => {
    const slow = new Promise<string>((res) => { const t = setTimeout(() => res("late"), 100); t.unref?.(); });
    await expect(withTimeout(slow, 20, "kimiInstant")).rejects.toThrow(/kimiInstant timed out after 20ms/);
  });

  it("propagates the inner rejection unchanged (not swallowed by the race)", async () => {
    const boom = Promise.reject(new Error("upstream 500"));
    await expect(withTimeout(boom, 1000, "x")).rejects.toThrow(/upstream 500/);
  });

  it("clears its timer on settle (a long timeout on a fast promise leaves no dangling handle)", async () => {
    await expect(withTimeout(Promise.resolve(42), 10_000, "y")).resolves.toBe(42);
  });
});
