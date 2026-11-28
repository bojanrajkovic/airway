import { errAsync, okAsync, ResultAsync } from "neverthrow";
import pg from "pg";
import { expect, onTestFinished } from "vitest";
import { test } from "@airway/testing/postgres";
import { withAdvisoryLock } from "../../src/db/lock.ts";

function poolFor(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  onTestFinished(async () => {
    await pool.end();
  });

  return pool;
}

/** Runs a try-mode lock in a second session and returns its result's error kind, or "ok". */
async function tryFromAnotherSession(pool: pg.Pool): Promise<string> {
  return (await withAdvisoryLock(pool, { kind: "try" }, () => okAsync("ok"))).match(
    (value) => value,
    (error) => error.kind,
  );
}

test("returns lock_unavailable to a try-mode call while another session holds the lock", async ({
  databaseUrl,
}) => {
  const pool = poolFor(databaseUrl);

  const inside = await withAdvisoryLock(pool, { kind: "try" }, () =>
    ResultAsync.fromSafePromise(tryFromAnotherSession(pool)),
  );

  expect(inside._unsafeUnwrap()).toBe("lock_unavailable");
  expect(await tryFromAnotherSession(pool)).toBe("ok");
});

test("returns lock_unavailable to a wait-mode call after its timeout", async ({ databaseUrl }) => {
  const pool = poolFor(databaseUrl);
  const timeout = Temporal.Duration.from({ milliseconds: 100 });

  const inside = await withAdvisoryLock(pool, { kind: "try" }, () =>
    withAdvisoryLock(pool, { kind: "wait", timeout }, () => okAsync("ok")).orElse((error) =>
      okAsync(error.kind),
    ),
  );

  expect(inside._unsafeUnwrap()).toBe("lock_unavailable");
});

test("resets lock_timeout before a wait-mode client returns to the pool", async ({
  databaseUrl,
}) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  onTestFinished(async () => {
    await pool.end();
  });
  const timeout = Temporal.Duration.from({ seconds: 5 });

  (
    await withAdvisoryLock(pool, { kind: "wait", timeout }, () => okAsync(undefined))
  )._unsafeUnwrap();
  const { rows } = await pool.query<{ lock_timeout: string }>("show lock_timeout");

  expect(rows[0]?.lock_timeout).toBe("0");
});

test("releases the lock when fn returns an error", async ({ databaseUrl }) => {
  const pool = poolFor(databaseUrl);

  const failed = await withAdvisoryLock(pool, { kind: "try" }, () =>
    errAsync({ kind: "boom" as const }),
  );

  expect(failed._unsafeUnwrapErr()).toEqual({ kind: "boom" });
  expect(await tryFromAnotherSession(pool)).toBe("ok");
});

test("releases the lock when fn throws", async ({ databaseUrl }) => {
  const pool = poolFor(databaseUrl);

  await expect(
    withAdvisoryLock(pool, { kind: "try" }, () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");

  expect(await tryFromAnotherSession(pool)).toBe("ok");
});
