import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { beforeEach, describe, expect, it } from "vitest";
import { readBreaths } from "../../src/ingest/breaths.ts";
import { folderContext, synthesizedNights, writeFolder } from "../support/cpap-folder.ts";

const { spans } = inMemoryTelemetry();

beforeEach(() => {
  spans.reset();
});

describe("readBreaths", () => {
  it("records the night, file count, and breath count on an ingest.breaths span", async () => {
    const { planned, files } = synthesizedNights([], 1);
    const [plan] = planned;

    if (plan === undefined) {
      throw new Error("expected a planned night");
    }

    const { blocks } = (
      await readBreaths(folderContext(await writeFolder(files)), plan)
    )._unsafeUnwrap();

    const span = spans.getFinishedSpans().find(({ name }) => name === "ingest.breaths");
    expect(span?.attributes).toEqual({
      "airway.night": plan.night.toString(),
      "airway.ingest.files": plan.segments.length,
      "airway.ingest.rows": blocks.reduce((sum, { ts }) => sum + ts.length, 0),
    });
    expect(spans.getFinishedSpans().filter(({ name }) => name === "edf.read_file")).toHaveLength(
      plan.segments.length,
    );
  });
});
