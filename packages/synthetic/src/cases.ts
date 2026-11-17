import type { ClockOffset } from "@airway/contract/clock";
import {
  DEFAULT_UTC_OFFSET,
  evening,
  nightFromLayout,
  type Interval,
  type MachineEvent,
  type MaskPeriod,
  type Random,
  type SyntheticNight,
} from "./model.ts";
import type { Breathing } from "./patients.ts";

/** What an edge case builds its nights from. */
export type EdgeCaseContext = {
  /** The case's own generator, so adding a case leaves every other night as it was. */
  random: Random;
  breathing: Breathing;
  /** The case's first night. Its other nights follow on later dates. */
  first: Temporal.PlainDate;
  zone: string;
};

/** An edge case's nights, plus any clock offsets they need beyond the default one. */
export type EdgeCaseNights = { nights: SyntheticNight[]; offsets: ClockOffset[] };

type EdgeCase = (context: EdgeCaseContext) => EdgeCaseNights;

type Layout = { periods: MaskPeriod[]; segmentTimes: Interval[] };

// Mask-on periods made of BRP files back to back. Each period lists its files in minutes, joined
// by `fileGap` seconds; `breaks[i]` seconds follow period i.
function layPeriods(
  start: Temporal.Instant,
  files: readonly (readonly number[])[],
  breaks: readonly number[],
  fileGap: number,
): Layout {
  const layout: Layout = { periods: [], segmentTimes: [] };
  let cursor = start;

  files.forEach((minutes, i) => {
    const on = cursor;

    minutes.forEach((length, j) => {
      const end = cursor.add({ minutes: length });

      layout.segmentTimes.push({ start: cursor, end });
      cursor = j < minutes.length - 1 ? end.add({ seconds: fileGap }) : end;
    });
    layout.periods.push({ on, off: cursor });
    cursor = cursor.add({ seconds: breaks[i] ?? 0 });
  });

  return layout;
}

const hypopnea = (at: Temporal.Instant): MachineEvent => ({ at, duration: 15, type: "hypopnea" });
const only = (night: SyntheticNight): EdgeCaseNights => ({ nights: [night], offsets: [] });

// 13 periods: 10 fill STR.edf's slots and 3 come after them. Period 5 starts 40 s after period 4,
// so its file is within 60 s of both slots. Period 11's two files are 90 s apart, the most that
// still joins, and period 13 starts 91 s after period 12, the least that splits. Events sit 45 s
// before a period (inside its 60 s slack) and 120 s after one (outside it), wherever the gap on
// that side is at least 5 minutes.
function manyPeriods({ random, breathing, first, zone }: EdgeCaseContext): EdgeCaseNights {
  const files = [...Array.from({ length: 10 }, () => [30]), [30, 30], [20], [20]];
  const breaks = [300, 300, 300, 40, 300, 300, 300, 300, 300, 300, 300, 91];
  const layout = layPeriods(evening(first, zone).toInstant().add({ hours: 1 }), files, breaks, 90);
  const roomy = (seconds: number | undefined): boolean => seconds === undefined || seconds >= 300;
  const extraEvents = layout.periods.flatMap(({ on, off }, i) => [
    ...(i > 0 && roomy(breaks[i - 1]) ? [hypopnea(on.subtract({ seconds: 45 }))] : []),
    ...(roomy(breaks[i]) ? [hypopnea(off.add({ seconds: 120 }))] : []),
  ]);

  return only(nightFromLayout(random, breathing, first, { ...layout, extraEvents }));
}

// The first period starts at 11:55 on the device clock, before the night's noon, so STR.edf's
// slot 0 has a mask-off but no mask-on. Ingest starts that session at noon.
function noonEdge({ random, breathing, first, zone }: EdgeCaseContext): EdgeCaseNights {
  const early = first.toZonedDateTime({ timeZone: DEFAULT_UTC_OFFSET, plainTime: "11:55" });
  const morning = layPeriods(early.toInstant(), [[45]], [], 90);
  const night = layPeriods(evening(first, zone).toInstant().add({ hours: 1 }), [[240]], [], 90);

  return only(
    nightFromLayout(random, breathing, first, {
      periods: [...morning.periods, ...night.periods],
      segmentTimes: [...morning.segmentTimes, ...night.segmentTimes],
      extraEvents: [],
    }),
  );
}

// A 30 s mask-on period between two others, too short for a BRP file. STR.edf records its
// mask-on and mask-off in the same minute, so ingest drops it.
function subMinutePeriod({ random, breathing, first, zone }: EdgeCaseContext): EdgeCaseNights {
  const start = evening(first, zone).toInstant().add({ hours: 1 });
  const before = layPeriods(start, [[120]], [], 90);
  const blipOn = start.add({ minutes: 130, seconds: 10 });
  const after = layPeriods(start.add({ minutes: 140 }), [[180]], [], 90);

  return only(
    nightFromLayout(random, breathing, first, {
      periods: [
        ...before.periods,
        { on: blipOn, off: blipOn.add({ seconds: 30 }) },
        ...after.periods,
      ],
      segmentTimes: [...before.segmentTimes, ...after.segmentTimes],
      extraEvents: [],
    }),
  );
}

/** Every edge case's name. `'all'` builds them in this order. */
export const EDGE_CASE_NAMES = ["many-periods", "noon-edge", "sub-minute-period"] as const;
export type EdgeCaseName = (typeof EDGE_CASE_NAMES)[number];

export const EDGE_CASES: Readonly<Record<EdgeCaseName, EdgeCase>> = {
  "many-periods": manyPeriods,
  "noon-edge": noonEdge,
  "sub-minute-period": subMinutePeriod,
};

/** The cases `'all'` or a list names, in `EDGE_CASE_NAMES` order. */
export const edgeCaseNames = (cases: "all" | readonly EdgeCaseName[]): EdgeCaseName[] =>
  EDGE_CASE_NAMES.filter((name) => cases === "all" || cases.includes(name));

/** A case's seed: the model's seed mixed with the case's name. */
export function edgeCaseSeed(seed: number, name: EdgeCaseName): number {
  let hash = seed;

  for (let i = 0; i < name.length; i += 1) {
    hash = (Math.imul(hash, 31) + name.charCodeAt(i)) >>> 0;
  }

  return hash;
}
