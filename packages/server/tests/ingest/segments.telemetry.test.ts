import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { beforeEach, describe, expect, it } from "vitest";
import { isReadable, readHeader } from "@airway/edf/header";
import { syntheticNights } from "@airway/synthetic/model";
import { cpapData } from "@airway/synthetic/cpap-data";
import { buildNight, type NightFiles } from "../../src/ingest/segments.ts";
import { readStr } from "../../src/ingest/str.ts";
import { capturingLogger, segmentFiles } from "../support/cpap-folder.ts";
import { testContext } from "../support/context.ts";

const { spans } = inMemoryTelemetry();

beforeEach(() => {
  spans.reset();
});

// Returns the damaged-files night, which has header-only files and a PLD file that's missing
// its BRP file.
function damagedNight(): NightFiles {
  const { nights, zone } = syntheticNights({
    seed: 7,
    nights: 0,
    cases: ["damaged-files"],
  })._unsafeUnwrap();
  const files = cpapData(nights, zone)._unsafeUnwrap();
  const bytes = files.find(({ path }) => path === "STR.edf")?.bytes ?? new Uint8Array();
  const str = readHeader(bytes)._unsafeUnwrap();
  const day = isReadable(str)
    ? readStr(bytes, str)
        ._unsafeUnwrap()
        .days.find((record) => record.used)
    : undefined;

  if (day === undefined) {
    throw new Error("expected a used day");
  }

  return { night: day.day, zone, day, files: segmentFiles(files, day.day) };
}

describe("buildNight", () => {
  it("records the night's counts on an ingest.segments span", () => {
    const input = damagedNight();
    const planned = buildNight(testContext(), input);
    const [span] = spans.getFinishedSpans().filter(({ name }) => name === "ingest.segments");

    expect(span?.attributes).toMatchObject({
      "airway.night": input.night.toString(),
      "airway.segments": planned.segments.length,
      "airway.sessions": planned.sessions.length,
      "airway.sessions.approximate": planned.approximate,
      "airway.segment_warnings": planned.warnings.length,
    });
  });

  it("adds a span event and writes a warn log for each warning, and both carry the warning's file path", () => {
    const { logger, lines } = capturingLogger();
    const input = damagedNight();
    const planned = buildNight(testContext({ logger }), input);
    const [span] = spans.getFinishedSpans().filter(({ name }) => name === "ingest.segments");
    const paths = planned.warnings.map(({ path }) => path);

    expect(paths).not.toHaveLength(0);
    expect(
      span?.events
        .filter(({ name }) => name === "ingest.segment_warning")
        .map(({ attributes }) => attributes?.["airway.file.path"]),
    ).toEqual(paths);

    const logged = lines.filter(({ msg }) => msg === "Segment warning");

    expect(logged).toHaveLength(paths.length);
    paths.forEach((path, i) => {
      expect(logged[i]).toMatchObject({
        level: "warn",
        module: "ingest.segments",
        night: input.night.toString(),
        warning: { path },
      });
    });
  });
});
