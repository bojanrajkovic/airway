import { randomLcg, randomNormal, randomPoisson, randomUniform } from "d3-random";
import { err, ok, type Result } from "neverthrow";
import { winterOffset } from "@airway/contract/clock";
import { EventType } from "@airway/contract/derived/values";
import {
  AIRSENSE,
  PLD_SAMPLE_SECONDS,
  step,
  type DataLabel,
  type EdfFileType,
} from "@airway/edf/airsense";
import type { EdfSamples } from "@airway/edf/signals";
import { samplesFor } from "@airway/edf/write";
import {
  APNEAS,
  BREATHING,
  MACHINE_EVENT_TYPES,
  type Breathing,
  type MachineEventType,
  type Patient,
  type WeightedRanges,
} from "./patients.ts";
import {
  EDGE_CASES,
  edgeCaseNames,
  edgeCaseSeed,
  type EdgeCaseError,
  type EdgeCaseName,
} from "./cases.ts";

export type SyntheticOptions = {
  seed: number;
  nights: number;
  /** Sets the first night's date. Defaults to an invented date. */
  start?: Temporal.PlainDate;
  /** Defaults to `child`. */
  patient?: Patient;
  /**
   * Sets the zone where bedtime falls between 20:00 and 22:00. Defaults to `.env.example`'s zone.
   */
  zone?: string;
  /** Selects the edge cases whose nights follow the base nights. Defaults to none. */
  cases?: "all" | readonly EdgeCaseName[];
};

/** Contains a model's nights and its home zone. */
export type Synthetic = { nights: SyntheticNight[]; zone: string };

/** Describes one session, which is a stretch of time with the mask on. */
export type MaskPeriod = { on: Temporal.Instant; off: Temporal.Instant };

/** Maps each PLD label to its 2 s series. */
export type PldSeries = EdfSamples<DataLabel<typeof AIRSENSE.pld>>;

// Date, MaskOn, and MaskOff depend on the device clock, so strFile fills them in.
const CLOCK_LABELS = ["Date", "MaskOn", "MaskOff"] as const;
/** Resolves to every STR.edf data label except Date, MaskOn, and MaskOff. */
export type NightStrLabel = Exclude<DataLabel<typeof AIRSENSE.str>, (typeof CLOCK_LABELS)[number]>;
export type NightStr = Readonly<Record<NightStrLabel, number>>;

export const isNightStrLabel = (label: DataLabel<typeof AIRSENSE.str>): label is NightStrLabel =>
  !(CLOCK_LABELS as readonly string[]).includes(label);

/** Describes the stretch of time that one BRP file covers, which lasts whole minutes. */
export type Segment = {
  start: Temporal.Instant;
  end: Temporal.Instant;
  /** Seeds the 25 Hz detail, so rendering one segment doesn't depend on any other. */
  seed: number;
  /** Each series has one value per 2 s, rounded to its signal's step. */
  pldSeries: PldSeries;
  brp: FileDamage;
  pldFiles: PldFiles;
  sad: FileDamage;
};

/**
 * Sets how `nightFiles` writes a file: whole, or damaged the way real cards damage files.
 *
 * - `empty`: the header, with a record count of -1, and no records
 * - `truncated`: cut partway through a record, before the count its header declares
 * - `unknown_length`: every record, but a record count of -1
 * - `undercounted`: every record, but a count one lower than the file holds
 */
export type FileDamage = "none" | "empty" | "truncated" | "unknown_length" | "undercounted";

/** Sets how `nightFiles` writes a segment's BRP, PLD, and SAD files. */
export type SegmentFiles = Pick<Segment, "brp" | "pldFiles" | "sad">;

/** Marks every file of a segment as undamaged, as in base nights. */
export const UNDAMAGED_FILES: SegmentFiles = {
  brp: "none",
  pldFiles: { files: "one", damage: "none" },
  sad: "none",
};

/** Sets a segment's PLD files: none, one, or two split at a record while the BRP file continues. */
export type PldFiles =
  | { files: "none" }
  | { files: "one"; damage: FileDamage }
  | { files: "split"; atRecord: number };

/**
 * Describes an event that the machine scores and writes to EVE. `at` is its start, and `duration`
 * is its length in seconds. The duration shapes the flow and pressure, but the machine writes it to
 * EVE only for apneas.
 */
export type MachineEvent = { at: Temporal.Instant; duration: number; type: MachineEventType };

/**
 * Describes a gap in breathing that appears in the flow signal.
 *
 * - `machine_apnea`: 10 to 30 s, and also a machine event
 * - `pediatric`: at least 2 breaths but under 10 s, which only airway's pediatric step finds
 * - `dip`: under 2 breaths, which nothing should flag
 */
export type Pause = {
  at: Temporal.Instant;
  duration: number;
  kind: "machine_apnea" | "pediatric" | "dip";
};

/** Sets one EVE file's start, and whether `nightFiles` writes a CSL file with the same start. */
export type EventFile = { start: Temporal.Instant; withCsl: boolean };

export type SyntheticNight = {
  night: Temporal.PlainDate;
  periods: readonly MaskPeriod[];
  segments: readonly Segment[];
  events: readonly MachineEvent[];
  pauses: readonly Pause[];
  /** Contains the night's EVE files in time order, and is empty when the night has no segments. */
  eventFiles: readonly EventFile[];
  /**
   * Maps each STR.edf label to the night's value, rounded to the signal's step. A value is NaN where
   * the machine writes -1.
   */
  str: NightStr;
};

const DEFAULT_START = Temporal.PlainDate.from("2030-01-07");
const DEFAULT_ZONE = "America/Chicago";
const MACHINE_APNEA_SECONDS = 10;
// A break between mask-on periods lasts at least 60 s, plus a log-normal value with a median of
// 140 s and a p95 near 25 minutes, so the whole break has a median near 200 s. The cap is 3 hours.
const BREAK_FLOOR_SECONDS = 60;
const BREAK_MEDIAN_EXTRA_SECONDS = 140;
const BREAK_SPREAD = 1.42;
const BREAK_CAP_SECONDS = 3 * 3600;
// The last mask-off comes an hour before noon on the device clock. Noon is the boundary between
// nights.
const LAST_OFF = Temporal.PlainTime.from("11:00");
// Keeps episodes this far into a segment, so the first breaths have room before a pause.
const LEAD_SECONDS = 10;
// Keeps episodes apart, so a pause never runs into the next event.
const EPISODE_SPACING_SECONDS = 30;

export type Random = {
  uniform: (min: number, max: number) => number;
  /** Returns an integer from `min` up to, but not including, `max`. */
  int: (min: number, max: number) => number;
  normal: (mean: number, sd: number) => number;
  poisson: (mean: number) => number;
  chance: (probability: number) => boolean;
};

// Every random value comes from one LCG, so one seed reproduces the whole model.
export function random(seed: number): Random {
  const source = randomLcg(seed);
  // Each distribution is built once, because building one per value made 2 s series slow.
  const unit = randomUniform.source(source)(0, 1);
  const standardNormal = randomNormal.source(source)(0, 1);
  const uniform = (min: number, max: number): number => min + (max - min) * unit();

  return {
    uniform,
    int: (min, max) => Math.floor(uniform(min, max)),
    normal: (mean, sd) => mean + sd * standardNormal(),
    poisson: (mean) => (mean > 0 ? randomPoisson.source(source)(mean)() : 0),
    chance: (probability) => unit() < probability,
  };
}

/** Rounds a value to its signal's step and keeps it in range. NaN stays NaN. */
function roundToStep(file: EdfFileType): (label: string, value: number) => number {
  const ranges = new Map(
    file.signals.map((signal) => [
      signal.label,
      { size: step(signal), min: Number(signal.physicalMin), max: Number(signal.physicalMax) },
    ]),
  );

  return (label, value) => {
    const range = ranges.get(label);

    if (range === undefined || Number.isNaN(value)) {
      return value;
    }

    const { size, min, max } = range;
    const steps = Math.round((Math.min(max, Math.max(min, value)) - min) / size);

    // Rounding again drops float noise, so 3 × 0.02 is 0.06, not 0.06000000000000001.
    return Math.round((min + steps * size) * 1e6) / 1e6;
  };
}

const snapPld = roundToStep(AIRSENSE.pld);
const snapStr = roundToStep(AIRSENSE.str);

/**
 * Generates `nights` random nights from `seed`, then appends the nights of each edge case in
 * `cases`, dated after the random nights. Returns an error when a case can't be built.
 */
export function syntheticNights(options: SyntheticOptions): Result<Synthetic, EdgeCaseError> {
  const r = random(options.seed);
  const breathing = BREATHING[options.patient ?? "child"];
  const start = options.start ?? DEFAULT_START;
  const zone = options.zone ?? DEFAULT_ZONE;
  const nights = Array.from({ length: options.nights }, (_, i) =>
    randomNight(r, breathing, evening(start.add({ days: i }), zone)),
  );
  let next = start.add({ days: options.nights });

  for (const name of edgeCaseNames(options.cases ?? [])) {
    const result = EDGE_CASES[name]({
      random: random(edgeCaseSeed(options.seed, name)),
      breathing,
      first: next,
      zone,
    });

    if (result.isErr()) {
      return err(result.error);
    }

    const built = result.value;

    nights.push(...built.nights);
    next = (built.nights.at(-1)?.night ?? next).add({ days: 1 });
  }

  // Accumulates the machine's total hours of use, starting from an invented number.
  let patientHours = 100;

  return ok({
    nights: nights.map((night) => {
      patientHours += night.str["OnDuration"] / 60;

      return { ...night, str: { ...night.str, PatientHours: Math.floor(patientHours) } };
    }),
    zone,
  });
}

/** Returns 20:00 on a night's date in the home time zone. */
export const evening = (night: Temporal.PlainDate, zone: string): Temporal.ZonedDateTime =>
  night.toZonedDateTime({ timeZone: zone, plainTime: "20:00" });

/** Generates a night with random periods and events, with bedtime up to 2 hours after `evening`. */
export function randomNight(
  r: Random,
  breathing: Breathing,
  evening: Temporal.ZonedDateTime,
): SyntheticNight {
  const short = r.chance(1 / 8);
  const bad = r.chance(1 / 10);
  const usageTarget = short ? r.int(120, 241) : r.int(420, 541);
  const bedtime = evening.toInstant().add({ minutes: r.int(0, 121) });
  const latest = evening
    .toPlainDate()
    .add({ days: 1 })
    .toZonedDateTime({
      timeZone: winterOffset(evening.timeZoneId, evening.year),
      plainTime: LAST_OFF,
    })
    .toInstant();
  const placed = placePeriods(r, { breathing, bedtime, latest, usageTarget });

  return finishNight(r, breathing, evening.toPlainDate(), {
    ...placed,
    bad,
    randomEvents: true,
    extraEvents: [],
  });
}

/**
 * Sets a night's mask-on periods and BRP file times by hand. `randomEvents` adds the model's own
 * events and pauses, which fall inside segments; `extraEvents` are added at their own `at` times.
 */
export type NightLayout = {
  periods: readonly MaskPeriod[];
  segmentTimes: readonly Interval[];
  randomEvents: boolean;
  extraEvents: readonly MachineEvent[];
};

/**
 * Builds a night with the given layout. Events, pauses, 2 s series, and STR.edf values are
 * generated as for any night, so they match the layout.
 */
export function nightFromLayout(
  r: Random,
  breathing: Breathing,
  night: Temporal.PlainDate,
  layout: NightLayout,
): SyntheticNight {
  return finishNight(r, breathing, night, { ...layout, bad: r.chance(1 / 10) });
}

type FinishInputs = NightLayout & { bad: boolean };

function finishNight(
  r: Random,
  breathing: Breathing,
  night: Temporal.PlainDate,
  { periods, segmentTimes, randomEvents, extraEvents, bad }: FinishInputs,
): SyntheticNight {
  const usage = Math.floor(
    periods.reduce((sum, { on, off }) => sum + on.until(off).total("seconds"), 0) / 60,
  );
  const rate = r.normal(breathing.rate.mean, breathing.rate.sd);
  const placed = randomEvents
    ? placeEpisodes(r, { breathing, segmentTimes, usage, bad, rate })
    : { events: [], pauses: [] };
  const events = [...placed.events, ...extraEvents].sort((a, b) =>
    Temporal.Instant.compare(a.at, b.at),
  );
  const { pauses } = placed;
  const segments = segmentTimes.map(({ start, end }): Segment => ({
    start,
    end,
    seed: r.int(0, 2 ** 31),
    pldSeries: generatePldSeries(r, { breathing, start, end, rate, events, pauses }),
    ...UNDAMAGED_FILES,
  }));

  return {
    night,
    periods,
    segments,
    events,
    pauses,
    eventFiles: firstEventFile(segments),
    str: strValues(r, { breathing, periods, segments, events, usage }),
  };
}

// Returns one EVE and CSL pair that starts 3 to 35 s before the first segment, as on a real card.
// The offset uses a generator seeded from the segment's seed, so `r`'s sequence is unchanged.
function firstEventFile(segments: readonly Segment[]): EventFile[] {
  const [first] = segments;

  return first === undefined
    ? []
    : [
        {
          start: first.start.subtract({ seconds: random(first.seed + 1).int(3, 36) }),
          withCsl: true,
        },
      ];
}

export type Interval = { start: Temporal.Instant; end: Temporal.Instant };
type PlacedPeriods = { periods: MaskPeriod[]; segmentTimes: Interval[] };

/** Picks one of the weighted ranges by weight, then picks a whole number from that range. */
function pick(r: Random, ranges: WeightedRanges): number {
  let draw = r.uniform(
    0,
    ranges.reduce((sum, { weight }) => sum + weight, 0),
  );

  for (const { weight, min, max } of ranges) {
    if (draw < weight) {
      return r.int(min, max + 1);
    }

    draw -= weight;
  }

  return ranges.at(-1)?.max ?? 0;
}

type PlannedFile = { minutes: number; gapAfter: number };
type PeriodInputs = {
  breathing: Breathing;
  bedtime: Temporal.Instant;
  latest: Temporal.Instant;
  usageTarget: number;
};

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

// Places mask-on periods and splits each into BRP files, with the patient's file gaps inside a
// period and long-tailed breaks between periods. Breaks shrink when needed so the last period ends
// by `latest`.
function placePeriods(
  r: Random,
  { breathing, bedtime, latest, usageTarget }: PeriodInputs,
): PlacedPeriods {
  const weights = Array.from({ length: pick(r, breathing.periods) }, () => r.uniform(1, 3));
  const total = sum(weights);
  const layouts = weights.map((weight): PlannedFile[] => {
    const files: PlannedFile[] = [];
    let remaining = Math.max(1, Math.round((usageTarget * weight) / total));

    while (remaining > 0) {
      const minutes = Math.min(remaining, r.int(30, 151));

      files.push({ minutes, gapAfter: pick(r, breathing.fileGaps) });
      remaining -= minutes;
    }

    return files;
  });
  const extras = layouts
    .slice(1)
    .map(() =>
      Math.min(
        BREAK_CAP_SECONDS - BREAK_FLOOR_SECONDS,
        Math.exp(r.normal(Math.log(BREAK_MEDIAN_EXTRA_SECONDS), BREAK_SPREAD)),
      ),
    );
  // A break or the night's end follows each period's last file, so that file's gap goes unused.
  const periodSeconds = sum(
    layouts.map(
      (files) =>
        sum(files.map((file) => file.minutes * 60 + file.gapAfter)) - (files.at(-1)?.gapAfter ?? 0),
    ),
  );
  const room =
    bedtime.until(latest).total("seconds") - periodSeconds - BREAK_FLOOR_SECONDS * extras.length;
  const scale = Math.min(1, Math.max(0, room) / Math.max(1, sum(extras)));
  const periods: MaskPeriod[] = [];
  const segmentTimes: Interval[] = [];
  let cursor = bedtime;

  for (const [i, files] of layouts.entries()) {
    const on = cursor;

    for (const [j, { minutes, gapAfter }] of files.entries()) {
      const end = cursor.add({ minutes });

      segmentTimes.push({ start: cursor, end });
      cursor = j < files.length - 1 ? end.add({ seconds: gapAfter }) : end;
    }

    periods.push({ on, off: cursor });
    cursor = cursor.add({
      seconds: BREAK_FLOOR_SECONDS + Math.floor((extras[i] ?? 0) * scale),
    });
  }

  return { periods, segmentTimes };
}

type EpisodeInputs = {
  breathing: Breathing;
  segmentTimes: readonly Interval[];
  usage: number;
  bad: boolean;
  rate: number;
};

// Describes something placed in the night: a scored event, an apnea that is both a scored event
// and a gap in flow, or a gap in flow that the machine doesn't score.
type EpisodeBody = { duration: number } & (
  | { kind: "event"; event: MachineEventType }
  | { kind: "apnea"; event: MachineEventType }
  | { kind: "pause"; pause: "pediatric" | "dip" }
);
type Episode = EpisodeBody & { at: Temporal.Instant };

const EVENT_SECONDS: Readonly<Record<MachineEventType, readonly [number, number]>> = {
  [EventType.ObstructiveApnea]: [MACHINE_APNEA_SECONDS, 31],
  [EventType.CentralApnea]: [MACHINE_APNEA_SECONDS, 31],
  [EventType.UnclassifiedApnea]: [MACHINE_APNEA_SECONDS, 31],
  [EventType.Hypopnea]: [10, 41],
  [EventType.Arousal]: [3, 16],
};

type Episodes = { events: MachineEvent[]; pauses: Pause[] };

// Places events and pauses at the patient's rates, inside segments and apart from each other. A bad
// night has four times the events; on a clustered night most of them bunch up.
function placeEpisodes(
  r: Random,
  { breathing, segmentTimes, usage, bad, rate }: EpisodeInputs,
): Episodes {
  const hours = usage / 60;
  const multiplier = bad ? 4 : 1;
  const breath = 60 / rate;
  const candidates: Episode[] = [];
  const clusters =
    bad || r.chance(1 / 5) ? Array.from({ length: r.int(1, 4) }, () => r.uniform(0, 1)) : [];
  // Returns a fraction of the way through the night. On a night with clusters, 60% of the
  // fractions fall near a cluster.
  const where = (): number => {
    const center = r.chance(0.6) ? clusters[r.int(0, clusters.length)] : undefined;

    return center === undefined
      ? r.uniform(0, 1)
      : Math.min(1, Math.max(0, center + r.normal(0, 0.01)));
  };

  for (const type of MACHINE_EVENT_TYPES) {
    const [min, max] = EVENT_SECONDS[type];

    for (let n = r.poisson(breathing.eventsPerHour[type] * hours * multiplier); n > 0; n -= 1) {
      candidates.push(
        placeAt(segmentTimes, where(), {
          kind: APNEAS.has(type) ? "apnea" : "event",
          duration: r.int(min, max),
          event: type,
        }),
      );
    }
  }

  // A pediatric pause lasts at least 2 breaths, but under the machine's 10 s limit. When 2 breaths
  // take about 10 s or longer, the night skips pediatric pauses.
  const pediatricMin = 2.2 * breath;

  if (pediatricMin < MACHINE_APNEA_SECONDS - 0.5) {
    for (let n = r.poisson(breathing.pediatricPausesPerHour * hours * multiplier); n > 0; n -= 1) {
      const duration = Math.round(r.uniform(pediatricMin, MACHINE_APNEA_SECONDS - 0.5) * 10) / 10;

      candidates.push(
        placeAt(segmentTimes, r.uniform(0, 1), { kind: "pause", duration, pause: "pediatric" }),
      );
    }
  }

  for (let n = r.poisson(breathing.dipsPerHour * hours); n > 0; n -= 1) {
    const duration = Math.round(r.uniform(0.6, 1.5) * breath * 10) / 10;

    candidates.push(
      placeAt(segmentTimes, r.uniform(0, 1), { kind: "pause", duration, pause: "dip" }),
    );
  }

  const kept = withoutOverlaps(candidates, segmentTimes);

  return {
    events: kept.flatMap((episode) =>
      episode.kind === "pause"
        ? []
        : [{ at: episode.at, duration: episode.duration, type: episode.event }],
    ),
    pauses: kept.flatMap((episode): Pause[] => {
      const { at, duration } = episode;

      if (episode.kind === "event") {
        return [];
      }

      return [{ at, duration, kind: episode.kind === "apnea" ? "machine_apnea" : episode.pause }];
    }),
  };
}

// Puts an episode at a fraction of the way through the night's segment time, skipping the gaps.
function placeAt(
  segmentTimes: readonly Interval[],
  fraction: number,
  episode: EpisodeBody,
): Episode {
  const lengths = segmentTimes.map(({ start, end }) => start.until(end).total("seconds"));
  let offset = fraction * lengths.reduce((sum, length) => sum + length, 0);

  for (const [i, segment] of segmentTimes.entries()) {
    const length = lengths[i] ?? 0;

    if (offset < length) {
      // Keep the whole episode inside the segment, and leave room for breaths before it.
      const seconds = Math.max(LEAD_SECONDS, Math.min(offset, length - episode.duration - 1));

      return { ...episode, at: segment.start.add({ milliseconds: Math.round(seconds * 1000) }) };
    }

    offset -= length;
  }

  const last = segmentTimes.at(-1);

  return {
    ...episode,
    at:
      last === undefined
        ? Temporal.Instant.fromEpochMilliseconds(0)
        : last.end.subtract({ seconds: episode.duration + 1 }),
  };
}

// Drops any episode that starts within 30 s of the previous one's end, or doesn't fit its segment.
function withoutOverlaps(
  candidates: readonly Episode[],
  segmentTimes: readonly Interval[],
): Episode[] {
  const sorted = [...candidates].sort((a, b) => Temporal.Instant.compare(a.at, b.at));
  const kept: Episode[] = [];

  for (const episode of sorted) {
    const end = episode.at.add({ milliseconds: Math.round(episode.duration * 1000) });
    const previous = kept.at(-1);
    const fits = segmentTimes.some(
      ({ start, end: segmentEnd }) =>
        Temporal.Instant.compare(start, episode.at) < 0 &&
        Temporal.Instant.compare(end, segmentEnd) < 0,
    );
    const clear =
      previous === undefined ||
      Temporal.Instant.compare(
        previous.at.add({
          milliseconds: Math.round((previous.duration + EPISODE_SPACING_SECONDS) * 1000),
        }),
        episode.at,
      ) <= 0;

    if (fits && clear) {
      kept.push(episode);
    }
  }

  return kept;
}

type SeriesInputs = {
  breathing: Breathing;
  start: Temporal.Instant;
  end: Temporal.Instant;
  rate: number;
  events: readonly MachineEvent[];
  pauses: readonly Pause[];
};

const seconds = (from: Temporal.Instant, to: Temporal.Instant): number =>
  from.until(to).total("seconds");

// Generates random values for the segment's nine PLD signals, one every 2 s:
// - The breathing rate drifts slowly around the night's rate.
// - Flow stops during apneas and pediatric pauses.
// - The AutoSet pressure rises after each apnea or hypopnea, then decreases toward the minimum.
function generatePldSeries(r: Random, inputs: SeriesInputs): PldSeries {
  const { breathing, start, end, rate, events, pauses } = inputs;
  const count = Math.round(seconds(start, end) / PLD_SAMPLE_SECONDS);
  const series = samplesFor(AIRSENSE.pld, () => new Float64Array(count));
  const { pressure: range, epr } = breathing;
  const minPressure = range.min;
  const maxPressure = range.max;
  const tidalVolume = r.normal(breathing.tidalVolume.mean, breathing.tidalVolume.sd);
  const leakBase = Math.max(0, r.normal(breathing.leak, 0.01));
  const spikes = Array.from({ length: r.poisson(count / 3600) }, () => {
    const at = r.int(0, count);

    return { from: at, to: at + r.int(30, 151), height: r.uniform(0.2, 0.6) };
  });
  // Converts an instant to a sample number, for placing each stop in flow and each pressure rise.
  const toSample = (at: Temporal.Instant): number => seconds(start, at) / PLD_SAMPLE_SECONDS;
  const stops = pauses
    .filter((pause) => pause.kind !== "dip")
    .map((pause) => ({
      from: toSample(pause.at),
      to: toSample(pause.at) + pause.duration / PLD_SAMPLE_SECONDS,
    }));
  const rises = new Set(
    events
      .filter((event) => event.type !== EventType.Arousal)
      .map((event) => Math.round(toSample(event.at) + event.duration / PLD_SAMPLE_SECONDS)),
  );
  let rateDrift = 0;
  let volumeDrift = 0;
  let pressure = minPressure;
  const set = (label: DataLabel<typeof AIRSENSE.pld>, i: number, value: number): void => {
    series[label].set([snapPld(label, value)], i);
  };

  for (let i = 0; i < count; i += 1) {
    rateDrift = 0.98 * rateDrift + r.normal(0, 0.1);
    volumeDrift = 0.98 * volumeDrift + r.normal(0, 0.003);
    pressure = rises.has(i) ? pressure + r.uniform(0.5, 1) : pressure - 0.002;
    pressure = Math.min(maxPressure, Math.max(minPressure, pressure));

    const stopped = stops.some(({ from, to }) => i >= from && i < to);
    const breathsPerMinute = rate + rateDrift;
    const volume = stopped ? 0 : tidalVolume + volumeDrift;
    const spike = spikes.reduce(
      (sum, { from, to, height }) => (i >= from && i < to ? sum + height : sum),
      0,
    );

    set("MaskPress.2s", i, pressure + r.normal(0, 0.05));
    set("Press.2s", i, pressure);
    set("EprPress.2s", i, Math.max(4, pressure - epr));
    set("Leak.2s", i, Math.max(0, leakBase + spike + r.normal(0, 0.01)));
    set("RespRate.2s", i, breathsPerMinute);
    set("TidVol.2s", i, volume);
    set("MinVent.2s", i, breathsPerMinute * volume);
    set("Snore.2s", i, r.chance(0.02) ? r.uniform(0.2, 1) : 0);
    set("FlowLim.2s", i, Math.max(0, r.normal(0.03, 0.03)));
  }

  return series;
}

/** Returns the `q` quantile of sorted values, interpolating between neighbors. */
function quantile(sorted: Float64Array, q: number): number {
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const low = sorted[below] ?? Number.NaN;
  const high = sorted[Math.min(below + 1, sorted.length - 1)] ?? low;

  return low + (high - low) * (position - below);
}

type StrInputs = {
  breathing: Breathing;
  periods: readonly MaskPeriod[];
  segments: readonly Segment[];
  events: readonly MachineEvent[];
  usage: number;
};

// Returns the night's STR.edf values. The medians and leak percentiles come from the 2 s series, as
// on the real machine. The machine computes maxima and pressure statistics from finer data than
// the 2 s file holds, so the model generates them as random values near the 2 s values.
function strValues(
  r: Random,
  { breathing, periods, segments, events, usage }: StrInputs,
): NightStr {
  const night = (label: DataLabel<typeof AIRSENSE.pld>): Float64Array => {
    const parts = segments.map((segment) => segment.pldSeries[label]);
    const values = new Float64Array(parts.reduce((sum, part) => sum + part.length, 0));

    parts.reduce((offset, part) => {
      values.set(part, offset);

      return offset + part.length;
    }, 0);

    return values.sort();
  };

  const leak = night("Leak.2s");
  const press = night("Press.2s");
  const mask = night("MaskPress.2s");
  const resp = night("RespRate.2s");
  const tidal = night("TidVol.2s");
  const vent = night("MinVent.2s");
  const max = (values: Float64Array): number => values.at(-1) ?? Number.NaN;
  const { epr } = breathing;
  const count = (types: readonly MachineEventType[]): number =>
    events.filter((event) => types.includes(event.type)).length;
  // Computes the machine's index in tenths as (600 × events) div minutes.
  const index = (n: number): number => (usage > 0 ? Math.floor((600 * n) / usage) / 10 : 0);
  const apneas = count([
    EventType.ObstructiveApnea,
    EventType.CentralApnea,
    EventType.UnclassifiedApnea,
  ]);
  const hypopneas = count([EventType.Hypopnea]);
  const ipap50 = quantile(press, 0.5) + r.uniform(-0.2, 0.2);
  const ipap95 = quantile(press, 0.95) + r.uniform(-0.2, 0.2);
  const ipapMax = max(press) + r.uniform(0.2, 1);

  const values: Omit<NightStr, "PatientHours"> = {
    MaskEvents: 2 * periods.length,
    Duration: usage + r.int(2, 11),
    OnDuration: usage,
    Mode: 1,
    ...breathing.settings,
    "S.AS.MinPress": breathing.pressure.min,
    "S.AS.MaxPress": breathing.pressure.max,
    "S.EPR.Level": breathing.epr,
    HeatedTube: 1,
    Humidifier: 1,
    "BlowPress.95": quantile(press, 0.95) + r.uniform(0.5, 1.5),
    "BlowPress.5": quantile(press, 0.05) + r.uniform(0.5, 1.5),
    "Flow.95": r.normal(0.5, 0.05),
    "Flow.5": r.normal(0.05, 0.01),
    "BlowFlow.50": r.normal(30, 3),
    "AmbHumidity.50": r.normal(10, 1),
    "HumTemp.50": r.normal(30, 1),
    "HTubeTemp.50": r.normal(27, 1),
    "HTubePow.50": r.normal(40, 5),
    "HumPow.50": r.normal(35, 5),
    // Without an oximeter, the machine writes -1.
    "SpO2.50": Number.NaN,
    "SpO2.95": Number.NaN,
    "SpO2.Max": Number.NaN,
    SpO2Thresh: Number.NaN,
    "MaskPress.50": quantile(mask, 0.5) + r.uniform(-0.3, 0.3),
    "MaskPress.95": quantile(mask, 0.95) + r.uniform(-0.3, 0.3),
    "MaskPress.Max": max(mask) + r.uniform(0.5, 2),
    "TgtIPAP.50": ipap50,
    "TgtIPAP.95": ipap95,
    "TgtIPAP.Max": ipapMax,
    "TgtEPAP.50": ipap50 - epr,
    "TgtEPAP.95": ipap95 - epr,
    "TgtEPAP.Max": ipapMax - epr,
    "Leak.50": quantile(leak, 0.5),
    "Leak.95": quantile(leak, 0.95),
    "Leak.70": quantile(leak, 0.7),
    "Leak.Max": max(leak) + r.uniform(0.04, 0.3),
    "MinVent.50": quantile(vent, 0.5),
    "MinVent.95": quantile(vent, 0.95),
    "MinVent.Max": max(vent) + r.uniform(0.5, 2),
    "RespRate.50": quantile(resp, 0.5),
    "RespRate.95": quantile(resp, 0.95) + r.uniform(0.4, 3),
    "RespRate.Max": max(resp) + r.uniform(2, 6),
    "TidVol.50": quantile(tidal, 0.5),
    "TidVol.95": quantile(tidal, 0.95),
    "TidVol.Max": max(tidal) + r.uniform(0.04, 0.2),
    AHI: index(apneas + hypopneas),
    HI: index(hypopneas),
    AI: index(apneas),
    OAI: index(count([EventType.ObstructiveApnea])),
    CAI: index(count([EventType.CentralApnea])),
    UAI: index(count([EventType.UnclassifiedApnea])),
    RIN: index(count([EventType.Arousal])),
    CSR: 0,
    "Fault.Device": 0,
    "Fault.Alarm": 0,
    "Fault.Humidifier": 0,
    "Fault.HeatedTube": 0,
  };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the labels are the keys of `values`, but Object.entries and Object.fromEntries type them as string
  const snapped = Object.fromEntries(
    Object.entries(values).map(([label, value]) => [label, snapStr(label, value)]),
  ) as Omit<NightStr, "PatientHours">;

  // syntheticNights replaces PatientHours with the running total.
  return { ...snapped, PatientHours: 0 };
}
