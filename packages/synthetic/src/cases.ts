import { err, ok, type Result } from "neverthrow";
import { winterOffset } from "@airway/contract/clock";
import { EventType } from "@airway/contract/derived/values";
import {
  randomNight,
  UNDAMAGED_FILES,
  evening,
  nightFromLayout,
  type Interval,
  type MachineEvent,
  type MaskPeriod,
  type Random,
  type SegmentFiles,
  type SyntheticNight,
} from "./model.ts";
import type { Breathing } from "./patients.ts";

/** Contains the inputs that an edge case builds its nights from. */
export type EdgeCaseContext = {
  /** Each case has its own generator, so adding a case leaves the other cases' nights unchanged. */
  random: Random;
  breathing: Breathing;
  /** Sets the case's first night. Its other nights follow on later dates. */
  first: Temporal.PlainDate;
  zone: string;
};

export type EdgeCaseNights = { nights: SyntheticNight[] };

/** A caller asked for a DST case in a zone that doesn't observe DST. */
export type EdgeCaseError = { kind: "no_dst_transition"; name: EdgeCaseName; zone: string };

type Built = Result<EdgeCaseNights, EdgeCaseError>;
type EdgeCase = (context: EdgeCaseContext) => Built;

type Layout = { periods: MaskPeriod[]; segmentTimes: Interval[] };

// Lays out mask-on periods made of BRP files:
// - `files[i]` lists the lengths of period i's files, in minutes.
// - `fileGap` is the gap between files within a period, in seconds.
// - `breaks[i]` is the break after period i, in seconds.
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

const hypopnea = (at: Temporal.Instant): MachineEvent => ({
  at,
  duration: 15,
  type: EventType.Hypopnea,
});
const only = (night: SyntheticNight): Built => ok({ nights: [night] });
// Returns 21:00 on the night's date in the home time zone.
const nineOClock = (night: Temporal.PlainDate, zone: string): Temporal.Instant =>
  evening(night, zone).toInstant().add({ hours: 1 });

// Builds 13 mask-on periods:
// - Periods 1 to 10 fill STR.edf's slots, and periods 11 to 13 come after them.
// - Period 5 starts 40 s after period 4, so its file is within 60 s of both slots.
// - Period 11's two files are 90 s apart, the longest gap that joins files into one period.
// - Period 13 starts 91 s after period 12, the shortest gap that splits periods.
// - A hypopnea 45 s before a period falls inside `assignEvents`'s 60 s slack.
// - A hypopnea 120 s after a period falls outside the slack.
// The case adds each hypopnea only where the break on that side is at least 5 minutes.
function manyPeriods({ random, breathing, first, zone }: EdgeCaseContext): Built {
  const files = [...Array.from({ length: 10 }, () => [30]), [30, 30], [20], [20]];
  const breaks = [300, 300, 300, 40, 300, 300, 300, 300, 300, 300, 300, 91];
  const layout = layPeriods(nineOClock(first, zone), files, breaks, 90);
  const roomy = (seconds: number | undefined): boolean => seconds === undefined || seconds >= 300;
  const extraEvents = layout.periods.flatMap(({ on, off }, i) => [
    ...(i > 0 && roomy(breaks[i - 1]) ? [hypopnea(on.subtract({ seconds: 45 }))] : []),
    ...(roomy(breaks[i]) ? [hypopnea(off.add({ seconds: 120 }))] : []),
  ]);

  return only(
    nightFromLayout(random, breathing, first, { ...layout, randomEvents: true, extraEvents }),
  );
}

// The first period starts at 11:55 on the device clock, before the night's noon, so STR.edf's
// slot 0 has a mask-off but no mask-on. Ingest starts that session at noon.
function noonEdge({ random, breathing, first, zone }: EdgeCaseContext): Built {
  const early = first.toZonedDateTime({
    timeZone: winterOffset(zone, first.year),
    plainTime: "11:55",
  });
  const morning = layPeriods(early.toInstant(), [[45]], [], 90);
  const night = layPeriods(nineOClock(first, zone), [[240]], [], 90);

  return only(
    nightFromLayout(random, breathing, first, {
      periods: [...morning.periods, ...night.periods],
      segmentTimes: [...morning.segmentTimes, ...night.segmentTimes],
      randomEvents: true,
      extraEvents: [],
    }),
  );
}

// Puts a 30 s mask-on period, which is too short for a BRP file, between two longer periods.
// STR.edf records its mask-on and mask-off in the same minute, so ingest drops the 30 s period.
function subMinutePeriod({ random, breathing, first, zone }: EdgeCaseContext): Built {
  const start = nineOClock(first, zone);
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
      randomEvents: true,
      extraEvents: [],
    }),
  );
}

// Builds six hours of use that only STR.edf records. The night's segment list is empty, so
// `cpapData` skips its DATALOG folder.
function folderlessDay({ random, breathing, first, zone }: EdgeCaseContext): Built {
  const { periods } = layPeriods(nineOClock(first, zone), [[360]], [], 90);

  return only(
    nightFromLayout(random, breathing, first, {
      periods,
      segmentTimes: [],
      randomEvents: false,
      extraEvents: [],
    }),
  );
}

// Builds two nights with two unused days between them. STR.edf stores -1 for an unused day.
function unusedDays({ random, breathing, first, zone }: EdgeCaseContext): Built {
  return ok({
    nights: [0, 3].map((days) =>
      randomNight(random, breathing, evening(first.add({ days }), zone)),
    ),
  });
}

// Builds two nights and raises the second night's maximum pressure by 1 cmH2O.
function settingsChange({ random, breathing, first, zone }: EdgeCaseContext): Built {
  const before = randomNight(random, breathing, evening(first, zone));
  const after = randomNight(random, breathing, evening(first.add({ days: 1 }), zone));
  const raised = { ...after.str, "S.AS.MaxPress": breathing.pressure.max + 1 };

  return ok({ nights: [before, { ...after, str: raised }] });
}

// 18 hypopneas in 400 minutes make an AHI of exactly 2.7.
function ahiRounding({ random, breathing, first, zone }: EdgeCaseContext): Built {
  const layout = layPeriods(nineOClock(first, zone), [[400]], [], 90);
  const start = layout.segmentTimes[0]?.start ?? nineOClock(first, zone);
  const extraEvents = Array.from({ length: 18 }, (_, i) =>
    hypopnea(start.add({ minutes: 10 + 20 * i })),
  );

  return only(
    nightFromLayout(random, breathing, first, { ...layout, randomEvents: false, extraEvents }),
  );
}

// Builds one period of BRP files, 30 s apart. `files[i]` sets how segment i's files are written.
function filesNight(
  { random, breathing, first, zone }: EdgeCaseContext,
  minutes: readonly number[],
  files: readonly SegmentFiles[],
): SyntheticNight {
  const night = nightFromLayout(random, breathing, first, {
    ...layPeriods(nineOClock(first, zone), [minutes], [], 30),
    randomEvents: true,
    extraEvents: [],
  });

  return {
    ...night,
    segments: night.segments.map((segment, i) => ({
      ...segment,
      ...(files[i] ?? UNDAMAGED_FILES),
    })),
  };
}

// Builds a night with damaged files beside whole ones: a 2-minute stretch whose BRP, PLD, and SAD
// are header only; a truncated BRP; a BRP with a -1 record count; and BRP, PLD, and SAD files that
// contain one more record than they declare. Ingest skips the header-only files, rejects the
// truncated one, and reads the rest.
function damagedFiles(context: EdgeCaseContext): Built {
  return only(
    filesNight(
      context,
      [30, 2, 30, 30, 30, 30],
      [
        UNDAMAGED_FILES,
        {
          brp: "empty",
          pldFiles: { files: "one", damage: "empty" },
          sad: "empty",
        },
        { ...UNDAMAGED_FILES, brp: "truncated" },
        { ...UNDAMAGED_FILES, brp: "unknown_length" },
        {
          brp: "undercounted",
          pldFiles: { files: "one", damage: "undercounted" },
          sad: "undercounted",
        },
      ],
    ),
  );
}

// Builds a night with a BRP that has no PLD, a PLD split into two files halfway through its BRP,
// and three EVE files, the last one without a CSL.
function splitFiles(context: EdgeCaseContext): Built {
  const night = filesNight(
    context,
    [30, 60, 60, 30],
    [
      UNDAMAGED_FILES,
      { ...UNDAMAGED_FILES, pldFiles: { files: "none" } },
      { ...UNDAMAGED_FILES, pldFiles: { files: "split", atRecord: 30 } },
    ],
  );
  const before = (i: number): Temporal.Instant =>
    (night.segments[i]?.start ?? nineOClock(context.first, context.zone)).subtract({ seconds: 10 });

  return only({
    ...night,
    eventFiles: [
      ...night.eventFiles,
      { start: before(2), withCsl: true },
      { start: before(3), withCsl: false },
    ],
  });
}

// Returns the date before the zone's first `direction` transition after `first`, or undefined
// when the zone has no such transition.
function transitionNight(
  first: Temporal.PlainDate,
  zone: string,
  direction: "fall-back" | "spring-forward",
): Temporal.PlainDate | undefined {
  let at: Temporal.ZonedDateTime | null = first.toZonedDateTime({ timeZone: zone });

  // A zone changes its clocks at most twice a year, so the next four transitions include both
  // directions.
  for (let i = 0; i < 4 && at !== null; i += 1) {
    at = at.getTimeZoneTransition("next");

    if (at !== null) {
      const fallsBack = at.offsetNanoseconds < at.subtract({ nanoseconds: 1 }).offsetNanoseconds;

      if (fallsBack === (direction === "fall-back")) {
        return at.toPlainDate().subtract({ days: 1 });
      }
    }
  }

  return undefined;
}

// Builds a night from 21:00 to about 05:00 that crosses the zone's next fall-back or
// spring-forward. A fall-back night has 01:00 twice, and a spring-forward night skips 02:00.
const dstCase =
  (name: "fall-back" | "spring-forward"): EdgeCase =>
  ({ random, breathing, first, zone }) => {
    const night = transitionNight(first, zone, name);

    if (night === undefined) {
      return err({ kind: "no_dst_transition", name, zone });
    }

    return only(
      nightFromLayout(random, breathing, night, {
        ...layPeriods(nineOClock(night, zone), [[120, 120, 120, 120]], [], 60),
        randomEvents: true,
        extraEvents: [],
      }),
    );
  };

/** Defines every edge case's name. `'all'` builds them in this order, leaving out the DST cases. */
export const EDGE_CASE_NAMES = [
  "many-periods",
  "noon-edge",
  "sub-minute-period",
  "folderless-day",
  "unused-days",
  "settings-change",
  "ahi-rounding",
  "damaged-files",
  "split-files",
  "fall-back",
  "spring-forward",
] as const;
export type EdgeCaseName = (typeof EDGE_CASE_NAMES)[number];

// `'all'` skips the DST cases, so a caller has to name them. Their dates depend on the zone, and
// a zone without DST can't build them.
const DST_CASES: ReadonlySet<EdgeCaseName> = new Set(["fall-back", "spring-forward"]);

export const EDGE_CASES: Readonly<Record<EdgeCaseName, EdgeCase>> = {
  "many-periods": manyPeriods,
  "noon-edge": noonEdge,
  "sub-minute-period": subMinutePeriod,
  "folderless-day": folderlessDay,
  "unused-days": unusedDays,
  "settings-change": settingsChange,
  "ahi-rounding": ahiRounding,
  "damaged-files": damagedFiles,
  "split-files": splitFiles,
  "fall-back": dstCase("fall-back"),
  "spring-forward": dstCase("spring-forward"),
};

/**
 * Returns the cases that `cases` selects, in `EDGE_CASE_NAMES` order. `'all'` leaves out the DST
 * cases.
 */
export const edgeCaseNames = (cases: "all" | readonly EdgeCaseName[]): EdgeCaseName[] =>
  EDGE_CASE_NAMES.filter((name) => (cases === "all" ? !DST_CASES.has(name) : cases.includes(name)));

/** Returns a case's seed, which mixes the model's seed with the case's name. */
export function edgeCaseSeed(seed: number, name: EdgeCaseName): number {
  let hash = seed;

  for (let i = 0; i < name.length; i += 1) {
    hash = (Math.imul(hash, 31) + name.charCodeAt(i)) >>> 0;
  }

  return hash;
}
