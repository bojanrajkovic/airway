import { describe, expect, it } from "vitest";
import type { DerivedRows } from "@airway/contract/derived/rows";
import { AIRSENSE, PLD_SAMPLE_SECONDS } from "@airway/edf/airsense";
import { readEdf } from "@airway/edf/file";
import { EdgeCaseName } from "@airway/synthetic/cases";
import type { CpapFile } from "@airway/synthetic/cpap-data";
import { syntheticNights } from "@airway/synthetic/model";
import { Patient } from "@airway/synthetic/patients";
import { synthesize } from "@airway/synthetic/synthesize";
import { readSamples, toSamples } from "../../src/ingest/samples.ts";
import { planSegments, type NightSegments } from "../../src/ingest/segments.ts";
import { folderContext, segmentFiles, usedDays, writeFolder } from "../support/cpap-folder.ts";
import { toSampleRows } from "../support/rows.ts";

const arrivedAt = Temporal.Instant.from("2030-03-01T12:00:00Z");

// Pairs one night of a synthetic folder with the segments that `planSegments` plans for it.
type PlannedNight = { night: Temporal.PlainDate; zone: string; plan: NightSegments };

// Holds a synthetic folder's planned nights, its files, and the rows that `synthesize` returns.
type Synthesized = { planned: PlannedNight[]; files: CpapFile[]; rows: DerivedRows };

function synthesized(cases: readonly EdgeCaseName[], nights = 0): Synthesized {
  const model = syntheticNights({ seed: 7, nights, cases })._unsafeUnwrap();
  const { files, rows } = synthesize(model.nights, model.zone, {
    patient: Patient.Child,
    arrivedAt,
  })._unsafeUnwrap();
  const planned = usedDays(files).flatMap((day): PlannedNight[] =>
    rows.nights.some(({ night }) => night.equals(day.day))
      ? [
          {
            night: day.day,
            zone: model.zone,
            plan: planSegments({
              night: day.day,
              zone: model.zone,
              day,
              files: segmentFiles(files, day.day),
            }),
          },
        ]
      : [],
  );

  return { planned, files, rows };
}

const pldOf = (files: readonly CpapFile[]): CpapFile => {
  const file = files.find(({ path }) => path.endsWith("_PLD.edf"));

  if (file === undefined) {
    throw new Error("expected a PLD file");
  }

  return file;
};

describe("toSamples", () => {
  it("starts at `start`, spaces rows 2 s apart, and rounds each value to its signal's step", () => {
    const pld = readEdf(pldOf(synthesized([], 1).files).bytes, AIRSENSE.pld)._unsafeUnwrap();
    // Rounding Leak to its 0.02 L/s step removes float error of this size.
    pld.samples["Leak.2s"][0] = 0.4 + 1e-12;
    const start = Temporal.Instant.from("2030-01-01T05:00:00Z");

    const { ts, signals } = toSamples(pld, start);

    expect(ts[0]).toBe(start.epochMilliseconds);
    expect((ts[1] ?? 0) - (ts[0] ?? 0)).toBe(PLD_SAMPLE_SECONDS * 1000);
    expect(ts).toHaveLength(pld.records * 30);
    expect(signals.leak[0]).toBe(0.4);
  });
});

describe("readSamples", () => {
  it.each<[string, EdgeCaseName[], number]>([
    ["plain nights", [], 2],
    ["a split PLD file", [EdgeCaseName.SplitFiles], 0],
  ])("matches synthesize's sample rows for %s", async (_, cases, nights) => {
    const { planned, files, rows } = synthesized(cases, nights);
    const ctx = folderContext(await writeFolder(files));

    for (const { night, zone, plan } of planned) {
      const blocks = (
        await readSamples(ctx, { night, zone, segments: plan.segments })
      )._unsafeUnwrap();

      expect(toSampleRows(night, blocks)).toEqual(
        rows.samples.filter((row) => row.night.equals(night)),
      );
    }
  });

  it("returns a block for each half of a split PLD file, with the second starting one step after the first ends", async () => {
    const { planned, files } = synthesized([EdgeCaseName.SplitFiles]);
    const ctx = folderContext(await writeFolder(files));
    const split = planned.find(({ plan }) => plan.segments.some(({ plds }) => plds.length === 2));

    if (split === undefined) {
      throw new Error("expected a segment with a split PLD file");
    }

    const blocks = (
      await readSamples(ctx, {
        night: split.night,
        zone: split.zone,
        segments: split.plan.segments,
      })
    )._unsafeUnwrap();
    const [first, second] = blocks.filter(({ segment }) =>
      split.plan.segments.some((s) => s.segment === segment && s.plds.length === 2),
    );

    expect(second?.ts[0]).toBe((first?.ts.at(-1) ?? 0) + PLD_SAMPLE_SECONDS * 1000);
  });

  it("returns a read_failed error with the path of a missing PLD file", async () => {
    const { planned, files } = synthesized([], 1);
    const [first] = planned;
    const pld = first?.plan.segments[0]?.plds[0]?.path;

    if (first === undefined || pld === undefined) {
      throw new Error("expected a night with a PLD file");
    }

    const ctx = folderContext(await writeFolder(files.filter(({ path }) => path !== pld)));
    const { night, zone, plan } = first;
    const error = (
      await readSamples(ctx, { night, zone, segments: plan.segments })
    )._unsafeUnwrapErr();

    expect(error).toMatchObject({ kind: "read_failed", path: pld });
  });
});
