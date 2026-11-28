import { ResultAsync } from "neverthrow";
import type pg from "pg";
import type { DerivedSchema } from "@airway/contract/derived/ddl";

/** Reports a database write that failed and rolled back. */
export type WriteError = { kind: "write_failed"; cause: unknown };

const writeFailed = (cause: unknown): WriteError => ({ kind: "write_failed", cause });

/**
 * Runs `statements` in one transaction on `client`, with `schema` as the search path. Rolls back
 * and returns `write_failed` when a statement fails.
 */
export function inTransaction<T>(
  client: pg.ClientBase,
  schema: DerivedSchema,
  statements: () => Promise<T>,
): ResultAsync<T, WriteError> {
  return ResultAsync.fromPromise(
    (async () => {
      await client.query("begin");

      try {
        await client.query(`set local search_path to ${schema}`);
        const result = await statements();
        await client.query("commit");

        return result;
      } catch (error) {
        // A failed rollback mustn't hide the error that caused it.
        await client.query("rollback").catch(() => undefined);

        throw error;
      }
    })(),
    writeFailed,
  );
}
