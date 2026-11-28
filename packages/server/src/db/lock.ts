// Takes the advisory lock that keeps polls, rebuilds, and notes migrations from running at the
// same time.
import { errAsync, okAsync, ResultAsync, type Result } from "neverthrow";
import type pg from "pg";

// The key's bytes spell "airw" in ASCII. One key covers every caller, so any two of them exclude each other.
const LOCK_KEY = 0x6169_7277;

type LockMode = { kind: "try" } | { kind: "wait"; timeout: Temporal.Duration };
type LockUnavailable = { kind: "lock_unavailable" };
type LockError = { kind: "lock_failed"; cause: unknown };

/** Reports why `withAdvisoryLock` couldn't take the lock. */
export type LockFailure = LockUnavailable | LockError;

const lockFailed = (cause: unknown): LockError => ({ kind: "lock_failed", cause });

// Postgres reports a wait that hit lock_timeout with SQLSTATE 55P03.
const isLockTimeout = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "55P03";

function acquire(
  client: pg.PoolClient,
  mode: LockMode,
): ResultAsync<void, LockUnavailable | LockError> {
  if (mode.kind === "try") {
    return ResultAsync.fromPromise(
      client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [LOCK_KEY]),
      lockFailed,
    ).andThen(({ rows }) =>
      rows[0]?.locked === true
        ? okAsync(undefined)
        : errAsync({ kind: "lock_unavailable" as const }),
    );
  }

  // `set local` ends with the transaction, so the client returns to the pool with its default
  // lock_timeout. The session-level lock outlasts the commit.
  return ResultAsync.fromPromise(
    (async () => {
      await client.query("begin");

      try {
        await client.query(
          `set local lock_timeout = ${mode.timeout.total("milliseconds").toFixed(0)}`,
        );
        await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);

        throw error;
      }
    })(),
    (cause): LockUnavailable | LockError =>
      isLockTimeout(cause) ? { kind: "lock_unavailable" } : lockFailed(cause),
  );
}

// Unlocks and returns the client to the pool. When the unlock fails, release destroys the
// connection, so Postgres frees the lock when the session ends.
async function release(client: pg.PoolClient, held: boolean, broken?: Error): Promise<void> {
  if (!held) {
    client.release(broken);

    return;
  }

  try {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    client.release();
  } catch (error) {
    client.release(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Takes airway's advisory lock on a client from `pool`, runs `fn` with that client, and releases
 * the lock when `fn` returns or throws.
 *
 * - `{ kind: "try" }` returns `lock_unavailable` at once when another session holds the lock.
 * - `{ kind: "wait", timeout }` waits up to `timeout`, then returns `lock_unavailable`.
 *
 * Any other database error while it takes the lock returns `lock_failed`.
 */
export function withAdvisoryLock<T, E>(
  pool: pg.Pool,
  mode: LockMode,
  fn: (client: pg.PoolClient) => ResultAsync<T, E>,
): ResultAsync<T, E | LockFailure> {
  return ResultAsync.fromPromise(pool.connect(), lockFailed).andThen(
    (client) =>
      new ResultAsync(
        (async (): Promise<Result<T, E | LockFailure>> => {
          let held = false;
          let broken: Error | undefined = undefined;

          try {
            return await acquire(client, mode)
              .orTee((error) => {
                // A failed lock query may have broken the connection, so the pool drops it.
                if (error.kind === "lock_failed") {
                  broken =
                    error.cause instanceof Error ? error.cause : new Error(String(error.cause));
                }
              })
              .andThen(() => {
                held = true;

                return fn(client);
              });
          } finally {
            await release(client, held, broken);
          }
        })(),
      ),
  );
}
