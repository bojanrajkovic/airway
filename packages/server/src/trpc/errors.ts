import { TRPCError, type TRPC_ERROR_CODE_KEY } from "@trpc/server";
import type { Result, ResultAsync } from "neverthrow";
import type { Tagged } from "../telemetry.ts";

/**
 * Returns the `Ok` value of a service's result, or throws a `TRPCError` with the code that
 * `codeFor` picks for the `Err`. Each service has one `codeFor` covering its whole error union, so
 * a new case fails to compile until it's mapped. The `TRPCError` includes only the code, because
 * the service already logged the details and the client doesn't need them.
 */
export async function toTRPC<T, E extends Tagged>(
  result: Result<T, E> | ResultAsync<T, E>,
  codeFor: (error: E) => TRPC_ERROR_CODE_KEY,
): Promise<T> {
  const settled = await result;
  if (settled.isErr()) {
    throw new TRPCError({ code: codeFor(settled.error) });
  }

  return settled.value;
}
