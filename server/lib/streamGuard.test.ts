import { guardStream, StreamTimeoutError } from "./streamGuard";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

// An iterable whose next() never resolves — models a stream that connects then
// stalls mid-iteration. return() resolves so guardStream's teardown completes.
function stallingStream(): AsyncIterable<number> & { returned: boolean } {
  const iterable = {
    returned: false,
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<number>>(() => {}),
        return: async () => {
          iterable.returned = true;
          return { value: undefined, done: true } as IteratorResult<number>;
        },
      };
    },
  };
  return iterable;
}

describe("guardStream", () => {
  it("passes through a slow-but-alive stream under both budgets", async () => {
    async function* slow() {
      for (const v of [1, 2, 3]) {
        await sleep(20);
        yield v;
      }
    }
    const out = await collect(guardStream(slow(), { idleMs: 200, totalMs: 2000 }));
    expect(out).toEqual([1, 2, 3]);
  });

  it("throws an idle timeout when the stream stalls between chunks", async () => {
    const onTimeout = jest.fn();
    await expect(
      collect(guardStream(stallingStream(), { idleMs: 40, totalMs: 5000, onTimeout })),
    ).rejects.toThrow(StreamTimeoutError);
    expect(onTimeout).toHaveBeenCalledWith("idle");
  });

  it("throws a total timeout even when chunks keep arriving (never idles)", async () => {
    const onTimeout = jest.fn();
    async function* steady() {
      let i = 0;
      while (true) {
        await sleep(10);
        yield i++;
      }
    }
    await expect(
      collect(guardStream(steady(), { idleMs: 500, totalMs: 80, onTimeout })),
    ).rejects.toThrow(/total/);
    expect(onTimeout).toHaveBeenCalledWith("total");
  });

  it("does not fire onTimeout for a stream that finishes in time", async () => {
    const onTimeout = jest.fn();
    async function* quick() {
      yield "a";
      yield "b";
    }
    const out = await collect(guardStream(quick(), { idleMs: 100, totalMs: 1000, onTimeout }));
    expect(out).toEqual(["a", "b"]);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("tears down the source iterator on timeout", async () => {
    const s = stallingStream();
    await expect(
      collect(guardStream(s, { idleMs: 30, totalMs: 5000 })),
    ).rejects.toThrow();
    expect(s.returned).toBe(true);
  });
});
