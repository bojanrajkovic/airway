import { TRPCError } from "@trpc/server";
import { errAsync, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { toTRPC } from "../../src/trpc/errors.ts";

type NightsError = { kind: "not_found" } | { kind: "not_imported" };

const nightsCode = (error: NightsError): "NOT_FOUND" | "CONFLICT" =>
  error.kind === "not_found" ? "NOT_FOUND" : "CONFLICT";

describe("toTRPC", () => {
  it("returns an Ok's value", async () => {
    await expect(toTRPC(ok(7), nightsCode)).resolves.toBe(7);
  });

  it.each([
    ["not_found", "NOT_FOUND"],
    ["not_imported", "CONFLICT"],
  ] as const)("throws %s as a TRPCError with code %s and no details", async (kind, code) => {
    const thrown = await toTRPC(errAsync<number, NightsError>({ kind }), nightsCode).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(TRPCError);
    expect(thrown).toMatchObject({ code, message: code, cause: undefined });
  });
});
