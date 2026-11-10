import { TRPCError, type TRPC_ERROR_CODE_KEY } from "@trpc/server";
import type { Result, ResultAsync } from "neverthrow";
import type { Tagged } from "../telemetry.ts";

/**
 * A service's result as a procedure's return value: the `Ok` value, or a `TRPCError` with the code
 * `codeFor` picks for the `Err`. Each service has one `codeFor` covering its whole error union, so
 * a new case fails to compile until it's mapped. The error carries only its code: the service
 * already logged the details, and they aren't the client's.
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
