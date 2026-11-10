import { transformer } from "@airway/contract/transformer";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../../src/http/app.ts";
import { testContext } from "../support/context.ts";

const app = createApp(testContext(), { webRoot: undefined });

const Success = z.object({ result: z.object({ data: z.unknown() }) });

/** The data in one tRPC success response, decoded with the shared transformer. */
const decode = (body: unknown): unknown =>
  transformer.parse(JSON.stringify(Success.parse(body).result.data));

describe("the tRPC API", () => {
  it("answers ping over GET with the caller's label", async () => {
    const response = await app.request("/trpc/ping");

    expect(response.status).toBe(200);
    expect(decode(await response.json())).toEqual({ author: "Sam" });
  });

  it("answers a query sent as POST, for inputs too long for a URL", async () => {
    const response = await app.request("/trpc/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transformer.serialize(undefined)),
    });

    expect(response.status).toBe(200);
    expect(decode(await response.json())).toEqual({ author: "Sam" });
  });

  it("answers a batch of calls in one request", async () => {
    const response = await app.request("/trpc/ping,ping?batch=1&input={}");

    expect(response.status).toBe(200);
    const bodies = z.array(z.unknown()).parse(await response.json());
    expect(bodies.map(decode)).toEqual([{ author: "Sam" }, { author: "Sam" }]);
  });

  it("answers 404 for a procedure that doesn't exist", async () => {
    expect((await app.request("/trpc/missing")).status).toBe(404);
  });
});
