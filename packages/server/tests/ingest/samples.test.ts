import { describe, expect, it } from "vitest";
import { AIRSENSE, PLD_SAMPLE_SECONDS } from "@airway/edf/airsense";
import { readEdf } from "@airway/edf/file";
import { EdgeCaseName } from "@airway/synthetic/cases";
import type { CpapFile } from "@airway/synthetic/cpap-data";
import { readSamples, toSamples } from "../../src/ingest/samples.ts";
import { folderContext, synthesizedNights, writeFolder } from "../support/cpap-folder.ts";
import { toSampleRows } from "../support/rows.ts";

const pldOf = (files: readonly CpapFile[]): CpapFile => {
  const file = files.find(({ path }) => path.endsWith("_PLD.edf"));

  if (file === undefined) {
    throw new Error("expected a PLD file");
  }

  return file;
};

describe("toSamples", () => {
  it("starts at `start`, spaces rows 2 s apart, and rounds each value to its signal's step", () => {
    const pld = readEdf(pldOf(synthesizedNights([], 1).files).bytes, AIRSENSE.pld)._unsafeUnwrap();
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
    const { planned, files, rows } = synthesizedNights(cases, nights);
    const ctx = folderContext(await writeFolder(files));

    for (const plan of planned) {
      const { blocks } = (await readSamples(ctx, plan))._unsafeUnwrap();

      expect(toSampleRows(plan.night, blocks)).toEqual(
        rows.samples.filter((row) => row.night.equals(plan.night)),
      );
    }
  });

  it("returns a block for each half of a split PLD file, with the second starting one step after the first ends", async () => {
    const { planned, files } = synthesizedNights([EdgeCaseName.SplitFiles]);
    const ctx = folderContext(await writeFolder(files));
    const split = planned.find(({ segments }) => segments.some(({ plds }) => plds.length === 2));

    if (split === undefined) {
      throw new Error("expected a segment with a split PLD file");
    }

    const { blocks } = (await readSamples(ctx, split))._unsafeUnwrap();
    const [first, second] = blocks.filter(({ segment }) =>
      split.segments.some((s) => s.segment === segment && s.plds.length === 2),
    );

    expect(second?.ts[0]).toBe((first?.ts.at(-1) ?? 0) + PLD_SAMPLE_SECONDS * 1000);
  });

  it("returns a read_failed error with the path of a missing PLD file", async () => {
    const { planned, files } = synthesizedNights([], 1);
    const [first] = planned;
    const pld = first?.segments[0]?.plds[0]?.path;

    if (first === undefined || pld === undefined) {
      throw new Error("expected a night with a PLD file");
    }

    const ctx = folderContext(await writeFolder(files.filter(({ path }) => path !== pld)));
    const error = (await readSamples(ctx, first))._unsafeUnwrapErr();

    expect(error).toMatchObject({ kind: "read_failed", path: pld });
  });
});
