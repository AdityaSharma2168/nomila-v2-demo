/**
 * pgAdvisoryLock — unit tests over a mocked pg pool.
 *
 * The point of this helper is that the lock and the unlock land on the SAME pinned
 * connection, and that the connection is always returned to the pool. Those are the
 * failure modes that would be invisible in production (a leaked client starves the pool;
 * an unlock on a different connection silently no-ops and wedges the job forever), so
 * they're asserted directly rather than through a real Postgres.
 */

const query   = jest.fn();
const release = jest.fn();
const connect = jest.fn(async () => ({ query, release }));

jest.mock("../db", () => ({ pool: { connect } }));

import { withAdvisoryLock, LOCK_INBOX_SYNC } from "./pgAdvisoryLock";

/** Make the next pg_try_advisory_lock resolve to `locked`. */
function lockReturns(locked: boolean) {
  query.mockImplementation(async (sql: string) =>
    sql.includes("pg_try_advisory_lock") ? { rows: [{ locked }] } : { rows: [] },
  );
}

beforeEach(() => {
  query.mockReset();
  release.mockReset();
  connect.mockClear();
});

describe("withAdvisoryLock", () => {
  it("runs the callback and releases the lock when it acquires", async () => {
    lockReturns(true);
    const fn = jest.fn(async () => "done");

    const out = await withAdvisoryLock(LOCK_INBOX_SYNC, fn);

    expect(out).toEqual({ ran: true, result: "done" });
    expect(fn).toHaveBeenCalledTimes(1);

    const sqls = query.mock.calls.map((c) => c[0] as string);
    expect(sqls[0]).toContain("pg_try_advisory_lock");
    expect(sqls[1]).toContain("pg_advisory_unlock");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("skips the callback entirely when another holder has the lock", async () => {
    lockReturns(false);
    const fn = jest.fn();

    const out = await withAdvisoryLock(LOCK_INBOX_SYNC, fn as any);

    expect(out).toEqual({ ran: false, result: undefined });
    expect(fn).not.toHaveBeenCalled();
    // Never unlock a lock we don't hold — that would release someone else's run.
    expect(query.mock.calls.map((c) => c[0] as string)).toEqual([
      expect.stringContaining("pg_try_advisory_lock"),
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("unlocks and releases when the callback throws, and propagates the error", async () => {
    lockReturns(true);

    await expect(
      withAdvisoryLock(LOCK_INBOX_SYNC, async () => {
        throw new Error("sync blew up");
      }),
    ).rejects.toThrow("sync blew up");

    expect(query.mock.calls.map((c) => c[0] as string)).toEqual([
      expect.stringContaining("pg_try_advisory_lock"),
      expect.stringContaining("pg_advisory_unlock"),
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("passes the key as a string so pg sends a valid int8", async () => {
    lockReturns(true);
    await withAdvisoryLock(LOCK_INBOX_SYNC, async () => null);

    // bigint is not serialisable by node-postgres; it must reach the driver as text.
    expect(query.mock.calls[0][1]).toEqual([LOCK_INBOX_SYNC.toString()]);
    expect(typeof query.mock.calls[0][1][0]).toBe("string");
  });

  it("still releases the connection when the unlock itself fails", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      throw new Error("connection reset");
    });

    const out = await withAdvisoryLock(LOCK_INBOX_SYNC, async () => "ok");

    // A failed unlock must not mask the successful run — the lock dies with the session.
    expect(out).toEqual({ ran: true, result: "ok" });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
