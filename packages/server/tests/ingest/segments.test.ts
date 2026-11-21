import { describe, expect, it } from "vitest";
import type { DerivedRows, SessionRow } from "@airway/contract/derived/rows";
import type { Session } from "@airway/contract/derived/sessions";
import type { UsedStrDay } from "@airway/contract/derived/str";
import { isReadable, readHeader } from "@airway/edf/header";
import type { EdgeCaseName } from "@airway/synthetic/cases";
import type { CpapFile } from "@airway/synthetic/cpap-data";
import { syntheticNights } from "@airway/synthetic/model";
import { synthesize } from "@airway/synthetic/synthesize";
import { planSegments, type NightFiles, type NightSegments } from "../../src/ingest/segments.ts";
import { readStr } from "../../src/ingest/str.ts";
import { segmentFiles } from "../support/cpap-folder.ts";

const arrivedAt = Temporal.Instant.from("2030-03-01T12:00:00Z");

// Each used day in a folder's STR.edf, as ingest reads it.
function usedDays(files: readonly CpapFile[]): UsedStrDay[] {
  const bytes = files.find(({ path }) => path === "STR.edf")?.bytes ?? new Uint8Array();
  const file = readHeader(bytes)._unsafeUnwrap();

  if (!isReadable(file)) {
    throw new Error("expected a readable STR.edf");
  }

  return readStr(bytes, file)
    ._unsafeUnwrap()
    .days.flatMap((day) => (day.used ? [day] : []));
}

// An edge case's planSegments input for each imported night, and the rows synthetic expects.
type Case = { inputs: NightFiles[]; files: CpapFile[]; rows: DerivedRows };

function edgeCase(name: EdgeCaseName): Case {
  const { nights, zone } = syntheticNights({ seed: 7, nights: 0, cases: [name] })._unsafeUnwrap();
  const { files, rows } = synthesize(nights, zone, { patient: "child", arrivedAt })._unsafeUnwrap();
  const inputs = usedDays(files).flatMap((day): NightFiles[] =>
    rows.nights.some(({ night }) => night.equals(day.day))
      ? [{ night: day.day, zone, day, files: segmentFiles(files, day.day) }]
      : [],
  );

  return { inputs, files, rows };
}

// The sessions synthesize expects, in buildSessions' shape.
const asSessions = (rows: readonly SessionRow[]): Session[] =>
  rows.map(({ session, ts, ended_at, source }) => ({ session, start: ts, end: ended_at, source }));

// What a night's plan would write to the segments table.
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
    "noon-edge",
    "many-periods",
    "split-files",
    "damaged-files",
    "fall-back",
    "spring-forward",
  ])("gives the sessions, segments, and file segments synthesize expects for %s", (name) => {
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
    const { inputs } = edgeCase("split-files");
    const [input] = inputs;
    const plan = input === undefined ? undefined : planSegments(input);

    it("attaches both halves of a split PLD to one segment", () => {
      expect(plan?.segments.some(({ plds }) => plds.length === 2)).toBe(true);
    });

    it("gives a BRP file with no PLD a segment with no PLD files", () => {
      expect(plan?.segments.some(({ plds }) => plds.length === 0)).toBe(true);
    });

    it("warns about each PLD file when the night has no BRP file", () => {
      const files = input?.files.filter(({ kind }) => kind === "pld") ?? [];
      const noBrp = input === undefined ? undefined : planSegments({ ...input, files });

      expect(noBrp?.segments).toEqual([]);
      expect(noBrp?.warnings.map(({ kind, path }) => [kind, path])).toEqual(
        files.map(({ path }) => ["unattached_pld", path]),
      );
    });
  });

  describe("damaged-files", () => {
    const { inputs } = edgeCase("damaged-files");
    const [input] = inputs;
    const plan = input === undefined ? undefined : planSegments(input);

    it("leaves out each header-only BRP and PLD file with a warning", () => {
      const headerOnly = input?.files.filter(({ edf }) => edf.size.verdict === "skip") ?? [];

      expect(new Set(headerOnly.map(({ kind }) => kind))).toEqual(new Set(["brp", "pld"]));
      expect(plan?.warnings.filter(({ kind }) => kind === "header_only")).toEqual(
        headerOnly.map(({ path, kind }) => ({ kind: "header_only", path, fileKind: kind })),
      );
    });

    it("ends a segment after every record on disk when its header undercounts", () => {
      const undercounted = plan?.segments.find(({ brp }) =>
        brp.edf.size.verdict === "read" ? brp.edf.size.header === "undercounted" : false,
      );
      const records = undercounted?.brp.edf.size.records ?? 0;

      expect(undercounted).toBeDefined();
      expect(undercounted?.start.until(undercounted.end).total("seconds")).toBe(records * 60);
    });
  });
});
