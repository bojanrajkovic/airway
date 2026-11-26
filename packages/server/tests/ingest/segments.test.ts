import { describe, expect, it } from "vitest";
import type { DerivedRows, SessionRow } from "@airway/contract/derived/rows";
import type { Session } from "@airway/contract/derived/sessions";
import { FileKind } from "@airway/contract/derived/values";
import { EdgeCaseName } from "@airway/synthetic/cases";
import type { CpapFile } from "@airway/synthetic/cpap-data";
import { syntheticNights } from "@airway/synthetic/model";
import { Patient } from "@airway/synthetic/patients";
import { synthesize } from "@airway/synthetic/synthesize";
import { planSegments, type NightFiles, type NightSegments } from "../../src/ingest/segments.ts";
import { segmentFiles, usedDays } from "../support/cpap-folder.ts";

const arrivedAt = Temporal.Instant.from("2030-03-01T12:00:00Z");

// Describes one edge case's test inputs and expected rows.
type Case = { inputs: NightFiles[]; files: CpapFile[]; rows: DerivedRows };

function edgeCase(name: EdgeCaseName): Case {
  const { nights, zone } = syntheticNights({ seed: 7, nights: 0, cases: [name] })._unsafeUnwrap();
  const { files, rows } = synthesize(nights, zone, {
    patient: Patient.Child,
    arrivedAt,
  })._unsafeUnwrap();
  const inputs = usedDays(files).flatMap((day): NightFiles[] =>
    rows.nights.some(({ night }) => night.equals(day.day))
      ? [{ night: day.day, zone, day, files: segmentFiles(files, day.day) }]
      : [],
  );

  return { inputs, files, rows };
}

// Converts the session rows that synthesize expects to buildSessions' shape.
const asSessions = (rows: readonly SessionRow[]): Session[] =>
  rows.map(({ session, ts, ended_at, source }) => ({ session, start: ts, end: ended_at, source }));

// Returns the rows that a night's plan would write to the segments table.
function asRows({ night }: NightFiles, plan: NightSegments): Pick<DerivedRows, "segments"> {
  return {
    segments: plan.segments.map(({ segment, session, start, end }) => ({
      night,
      segment,
      session,
      ts: start,
      ended_at: end,
    })),
  };
}

const byPath = ([a]: [string, number], [b]: [string, number]): number => a.localeCompare(b);

const fileSegments = (plan: NightSegments): [string, number][] =>
  plan.segments
    .flatMap(({ segment, brp, plds }) =>
      [brp, ...plds].map(({ path }): [string, number] => [path, segment]),
    )
    .toSorted(byPath);

describe("planSegments", () => {
  it.each<EdgeCaseName>([
    EdgeCaseName.NoonEdge,
    EdgeCaseName.ManyPeriods,
    EdgeCaseName.SplitFiles,
    EdgeCaseName.DamagedFiles,
    EdgeCaseName.FallBack,
    EdgeCaseName.SpringForward,
  ])("returns the sessions, segments, and file segments that synthesize expects for %s", (name) => {
    const { inputs, rows } = edgeCase(name);

    expect(inputs).not.toHaveLength(0);

    for (const input of inputs) {
      const plan = planSegments(input);
      const ofNight = <T extends { night: Temporal.PlainDate | null }>(list: readonly T[]): T[] =>
        list.filter(({ night }) => night?.equals(input.night) === true);

      expect(plan.sessions).toStrictEqual(asSessions(ofNight(rows.sessions)));
      expect(asRows(input, plan)).toEqual({ segments: ofNight(rows.segments) });
      expect(fileSegments(plan)).toEqual(
        ofNight(rows.files)
          .flatMap(({ path, segment }): [string, number][] =>
            segment === null ? [] : [[path, segment]],
          )
          .toSorted(byPath),
      );
    }
  });

  describe("split-files", () => {
    const { inputs } = edgeCase(EdgeCaseName.SplitFiles);
    const [input] = inputs;
    const plan = input === undefined ? undefined : planSegments(input);

    it("attaches both halves of a split PLD to one segment", () => {
      expect(plan?.segments.some(({ plds }) => plds.length === 2)).toBe(true);
    });

    it("plans a segment with an empty PLD list for a BRP file that has no PLD", () => {
      expect(plan?.segments.some(({ plds }) => plds.length === 0)).toBe(true);
    });

    it("warns about each PLD file when the night has no BRP file", () => {
      const files = input?.files.filter(({ kind }) => kind === FileKind.Pld) ?? [];
      const noBrp = input === undefined ? undefined : planSegments({ ...input, files });

      expect(noBrp?.segments).toEqual([]);
      expect(noBrp?.warnings.map(({ kind, path }) => [kind, path])).toEqual(
        files.map(({ path }) => ["unattached_pld", path]),
      );
    });
  });

  describe("damaged-files", () => {
    const { inputs } = edgeCase(EdgeCaseName.DamagedFiles);
    const [input] = inputs;
    const plan = input === undefined ? undefined : planSegments(input);

    it("skips each header-only BRP and PLD file and warns about it", () => {
      const headerOnly = input?.files.filter(({ edf }) => edf.size.verdict === "skip") ?? [];

      expect(new Set(headerOnly.map(({ kind }) => kind))).toEqual(new Set(["brp", "pld"]));
      expect(plan?.warnings.filter(({ kind }) => kind === "header_only")).toEqual(
        headerOnly.map(({ path, kind }) => ({ kind: "header_only", path, fileKind: kind })),
      );
    });

    it("ends a segment after the last record on disk when the BRP header undercounts the records", () => {
      const undercounted = plan?.segments.find(({ brp }) =>
        brp.edf.size.verdict === "read" ? brp.edf.size.header === "undercounted" : false,
      );
      const records = undercounted?.brp.edf.size.records ?? 0;

      expect(undercounted).toBeDefined();
      expect(undercounted?.start.until(undercounted.end).total("seconds")).toBe(records * 60);
    });
  });
});
