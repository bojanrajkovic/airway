// Wraps pg's client.query in a ResultAsync so callers can chain statements with andThen.
import { ResultAsync } from "neverthrow";
import type pg from "pg";

/** Reports a statement that failed. `cause` is the error that pg threw. */
export type QueryError = { kind: "query_failed"; cause: unknown };

/** Runs `text` with `values` on `client` and returns `query_failed` when the statement fails. */
export const query = <R extends pg.QueryResultRow = pg.QueryResultRow>(
  client: pg.ClientBase,
  text: string,
  values: unknown[] = [],
): ResultAsync<pg.QueryResult<R>, QueryError> =>
  ResultAsync.fromPromise(client.query<R>(text, values), (cause): QueryError => ({
    kind: "query_failed",
    cause,
  }));
