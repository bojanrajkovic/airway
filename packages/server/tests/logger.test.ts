import { Writable } from "node:stream";
import { expect, it } from "vitest";
import { createLogger } from "../src/logger.ts";
import { testContext } from "./support/context.ts";

it("hides the birth date and database URLs even when a whole context is logged", () => {
  let output = "";
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  const { config } = testContext();

  createLogger("info", sink).info({ ctx: { config }, password: "hunter2" }, "everything");

  expect(output).not.toContain("2012-06-15");
  expect(output).not.toContain("secret@");
  expect(output).not.toContain("hunter2");
  expect(output).toContain("[redacted]");
});
