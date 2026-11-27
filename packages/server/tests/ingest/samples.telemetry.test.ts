import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { beforeEach, describe, expect, it } from "vitest";
import { syntheticNights } from "@airway/synthetic/model";
import { cpapData } from "@airway/synthetic/cpap-data";
import { readSamples } from "../../src/ingest/samples.ts";
import { planSegments } from "../../src/ingest/segments.ts";
import { folderContext, segmentFiles, usedDays, writeFolder } from "../support/cpap-folder.ts";

const { spans } = inMemoryTelemetry();

beforeEach(() => {
  spans.reset();
});

describe("readSamples", () => {
  it("records the night, file count, and row count on an ingest.samples span", async () => {
    const { nights, zone } = syntheticNights({ seed: 7, nights: 1 })._unsafeUnwrap();
    const files = cpapData(nights, zone)._unsafeUnwrap();
    const [day] = usedDays(files);

    if (day === undefined) {
      throw new Error("expected a used day");
    }

    const plan = planSegments({ night: day.day, zone, day, files: segmentFiles(files, day.day) });
    const ctx = folderContext(await writeFolder(files));
    const { blocks } = (
      await readSamples(ctx, { night: day.day, zone, segments: plan.segments })
    )._unsafeUnwrap();

    const span = spans.getFinishedSpans().find(({ name }) => name === "ingest.samples");
    expect(span?.attributes).toEqual({
      "airway.night": day.day.toString(),
      "airway.ingest.files": plan.segments.flatMap(({ plds }) => plds).length,
      "airway.ingest.rows": blocks.reduce((sum, { ts }) => sum + ts.length, 0),
    });
    expect(spans.getFinishedSpans().filter(({ name }) => name === "edf.read_file")).toHaveLength(
      blocks.length,
    );
  });
});
