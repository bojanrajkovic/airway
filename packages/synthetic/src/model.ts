import { randomLcg, randomNormal, randomPoisson, randomUniform } from "d3-random";
import { AIRSENSE, dataSignals, step, type EdfFile } from "@airway/contract/edf/airsense";
import {
  BREATHING,
  MACHINE_EVENT_TYPES,
  type Breathing,
  type MachineEventType,
  type Patient,
} from "./patients.ts";

export type SyntheticOptions = {
  seed: number;
  nights: number;
  /** The first night. Defaults to an invented date. */
  start?: Temporal.PlainDate;
  /** Defaults to `child`. */
  patient?: Patient;
  /** Where bedtime falls at 20:00 to 22:00. Defaults to `.env.example`'s zone. */
  zone?: string;
};

/** A stretch with the mask on: one session. */
export type MaskPeriod = { on: Temporal.Instant; off: Temporal.Instant };

/** The labels of PLD's nine 2 s signals, in header order. */
export const PLD_LABELS = dataSignals(AIRSENSE.pld).map((signal) => signal.label);

/** One BRP file's stretch, a whole number of minutes long. */
export type Segment = {
  start: Temporal.Instant;
  end: Temporal.Instant;
  /** Seeds the 25 Hz detail, so rendering one segment doesn't depend on any other. */
  seed: number;
  /** The nine 2 s series by PLD label, one value per 2 s, on each signal's step. */
  pld: ReadonlyMap<string, Float64Array>;
};

/** An event the machine scores and writes to EVE. `at` is its start; `duration` is in seconds. */
export type MachineEvent = { at: Temporal.Instant; duration: number; type: MachineEventType };

/**
 * A gap in breathing that the flow signal shows.
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

export type SyntheticNight = {
  night: Temporal.PlainDate;
  periods: readonly MaskPeriod[];
  segments: readonly Segment[];
  events: readonly MachineEvent[];
  pauses: readonly Pause[];
  /**
   * STR.edf's values for the night by label, on each signal's step, NaN where the machine writes
   * -1. Date, MaskOn, MaskOff, and Crc16 are left out: they depend on the device clock or the file.
   */
  str: ReadonlyMap<string, number>;
};

const DEFAULT_START = Temporal.PlainDate.from("2030-01-07");
const DEFAULT_ZONE = "America/Chicago";
const SAMPLE_SECONDS = 2;
const MACHINE_APNEA_SECONDS = 10;
// Keeps episodes this far into a segment, so the first breaths have room before a pause.
const LEAD_SECONDS = 10;
// Keeps episodes apart, so a pause never runs into the next event.
const EPISODE_SPACING_SECONDS = 30;
const APNEAS: ReadonlySet<MachineEventType> = new Set([
  "obstructive_apnea",
  "central_apnea",
  "unclassified_apnea",
]);

export type Random = {
  uniform: (min: number, max: number) => number;
  /** An integer from `min` up to, but not including, `max`. */
  int: (min: number, max: number) => number;
  normal: (mean: number, sd: number) => number;
  poisson: (mean: number) => number;
  chance: (probability: number) => boolean;
};

// Every draw comes from one LCG, so one seed reproduces the whole model.
export function random(seed: number): Random {
  const source = randomLcg(seed);
  // Each distribution is built once, because building one per draw made a night of 2 s samples slow.
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
function snapper(file: EdfFile): (label: string, value: number) => number {
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

const snapPld = snapper(AIRSENSE.pld);
const snapStr = snapper(AIRSENSE.str);

/**
 * Builds a fixed, invented set of nights from a seed. The same options always give the same
 * nights. Unused days are days with no night in the list.
 */
export function syntheticNights(options: SyntheticOptions): SyntheticNight[] {
  const r = random(options.seed);
  const breathing = BREATHING[options.patient ?? "child"];
  const start = options.start ?? DEFAULT_START;
  const zone = options.zone ?? DEFAULT_ZONE;
  // The machine's running total of hours used, starting from an invented number.
  let patientHours = 100;

  return Array.from({ length: options.nights }, (_, i) => {
    const night = buildNight(
      r,
      breathing,
      start.add({ days: i }).toZonedDateTime({ timeZone: zone, plainTime: "20:00" }),
    );

    patientHours += Number(night.str.get("OnDuration")) / 60;
    const str = new Map(night.str).set("PatientHours", Math.floor(patientHours));

    return { ...night, str };
  });
}

function buildNight(
  r: Random,
  breathing: Breathing,
  evening: Temporal.ZonedDateTime,
): SyntheticNight {
  const short = r.chance(1 / 8);
  const bad = r.chance(1 / 10);
  const usageTarget = short ? r.int(120, 241) : r.int(420, 541);
  const bedtime = evening.toInstant().add({ minutes: r.int(0, 121) });
  const { periods, segmentTimes } = placePeriods(r, bedtime, usageTarget);
  const usage = Math.floor(
    periods.reduce((sum, { on, off }) => sum + on.until(off).total("seconds"), 0) / 60,
  );
  const rate = r.normal(breathing.rate.mean, breathing.rate.sd);
  const { events, pauses } = placeEpisodes(r, { breathing, segmentTimes, usage, bad, rate });
  const segments = segmentTimes.map(({ start, end }): Segment => ({
    start,
    end,
    seed: r.int(0, 2 ** 31),
    pld: pldSeries(r, { breathing, start, end, rate, events, pauses }),
  }));

  return {
    night: evening.toPlainDate(),
    periods,
    segments,
    events,
    pauses,
    str: strValues(r, { breathing, periods, segments, events, usage }),
  };
}

type Interval = { start: Temporal.Instant; end: Temporal.Instant };
type PlacedPeriods = { periods: MaskPeriod[]; segmentTimes: Interval[] };

// One to three mask-on periods with short breaks, each split into BRP segments 60 to 120 s apart.
function placePeriods(r: Random, bedtime: Temporal.Instant, usageTarget: number): PlacedPeriods {
  const count = r.int(1, 4);
  const weights = Array.from({ length: count }, () => r.uniform(1, 3));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const periods: MaskPeriod[] = [];
  const segmentTimes: Interval[] = [];
  let cursor = bedtime;

  for (const weight of weights) {
    let remaining = Math.max(1, Math.round((usageTarget * weight) / total));
    const first = segmentTimes.length;

    while (remaining > 0) {
      const minutes = Math.min(remaining, r.int(30, 151));
      const end = cursor.add({ minutes });

      segmentTimes.push({ start: cursor, end });
      remaining -= minutes;
      cursor = end.add({ seconds: r.int(60, 121) });
    }

    const on = segmentTimes[first]?.start ?? cursor;
    const off = segmentTimes.at(-1)?.end ?? cursor;

    periods.push({ on, off });
    cursor = off.add({ minutes: r.int(2, 21) });
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

// Something placed in the night: a scored event, an apnea that is both a scored event and a gap
// in flow, or a gap in flow the machine doesn't score.
type EpisodeBody = { duration: number } & (
  | { kind: "event"; event: MachineEventType }
  | { kind: "apnea"; event: MachineEventType }
  | { kind: "pause"; pause: "pediatric" | "dip" }
);
type Episode = EpisodeBody & { at: Temporal.Instant };

const EVENT_SECONDS: Readonly<Record<MachineEventType, readonly [number, number]>> = {
  obstructive_apnea: [MACHINE_APNEA_SECONDS, 31],
  central_apnea: [MACHINE_APNEA_SECONDS, 31],
  unclassified_apnea: [MACHINE_APNEA_SECONDS, 31],
  hypopnea: [10, 41],
  arousal: [3, 16],
};

type Episodes = { events: MachineEvent[]; pauses: Pause[] };

// Events and pauses at the patient's rates, inside segments and apart from each other. A bad
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
  // A fraction of the way through the night: near a cluster 60% of the time, if there are any.
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

  // At least 2 breaths, but under the machine's 10 s limit. A slow breather may have no room.
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

// The nine 2 s series of one segment. Breathing drifts slowly around the night's rate, flow
// stops during apneas and pediatric pauses, and the AutoSet pressure rises after each apnea or
// hypopnea and eases back toward the minimum.
function pldSeries(r: Random, inputs: SeriesInputs): Map<string, Float64Array> {
  const { breathing, start, end, rate, events, pauses } = inputs;
  const count = Math.round(seconds(start, end) / SAMPLE_SECONDS);
  const series = new Map(PLD_LABELS.map((label) => [label, new Float64Array(count)]));
  const { pressure: range, epr } = breathing;
  const minPressure = range.min;
  const maxPressure = range.max;
  const tidalVolume = r.normal(breathing.tidalVolume.mean, breathing.tidalVolume.sd);
  const leakBase = Math.max(0, r.normal(breathing.leak, 0.01));
  const spikes = Array.from({ length: r.poisson(count / 3600) }, () => {
    const at = r.int(0, count);

    return { from: at, to: at + r.int(30, 151), height: r.uniform(0.2, 0.6) };
  });
  // When each stop in flow and each pressure rise happens, in sample numbers.
  const toSample = (at: Temporal.Instant): number => seconds(start, at) / SAMPLE_SECONDS;
  const stops = pauses
    .filter((pause) => pause.kind !== "dip")
    .map((pause) => ({
      from: toSample(pause.at),
      to: toSample(pause.at) + pause.duration / SAMPLE_SECONDS,
    }));
  const rises = new Set(
    events
      .filter((event) => event.type !== "arousal")
      .map((event) => Math.round(toSample(event.at) + event.duration / SAMPLE_SECONDS)),
  );
  let rateDrift = 0;
  let volumeDrift = 0;
  let pressure = minPressure;
  const set = (label: string, i: number, value: number): void => {
    series.get(label)?.set([snapPld(label, value)], i);
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

/** The `q` quantile of sorted values, interpolating between neighbors. */
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

// The night's STR.edf values. Like the real machine's, the medians and leak percentiles come from
// the 2 s data, while maxima and pressure statistics come from finer data the 2 s file doesn't
// hold, so they're drawn near the 2 s values instead.
function strValues(
  r: Random,
  { breathing, periods, segments, events, usage }: StrInputs,
): Map<string, number> {
  const night = (label: string): Float64Array => {
    const parts = segments.map((segment) => segment.pld.get(label) ?? new Float64Array());
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
  // The machine's index in tenths: (600 × events) div minutes.
  const index = (n: number): number => (usage > 0 ? Math.floor((600 * n) / usage) / 10 : 0);
  const apneas = count(["obstructive_apnea", "central_apnea", "unclassified_apnea"]);
  const hypopneas = count(["hypopnea"]);
  const ipap50 = quantile(press, 0.5) + r.uniform(-0.2, 0.2);
  const ipap95 = quantile(press, 0.95) + r.uniform(-0.2, 0.2);
  const ipapMax = max(press) + r.uniform(0.2, 1);

  const values: [string, number][] = [
    ["MaskEvents", 2 * periods.length],
    ["Duration", usage + r.int(2, 11)],
    ["OnDuration", usage],
    ["Mode", 1],
    ...Object.entries(breathing.settings),
    ["S.AS.MinPress", breathing.pressure.min],
    ["S.AS.MaxPress", breathing.pressure.max],
    ["S.EPR.Level", breathing.epr],
    ["HeatedTube", 1],
    ["Humidifier", 1],
    ["BlowPress.95", quantile(press, 0.95) + r.uniform(0.5, 1.5)],
    ["BlowPress.5", quantile(press, 0.05) + r.uniform(0.5, 1.5)],
    ["Flow.95", r.normal(0.5, 0.05)],
    ["Flow.5", r.normal(0.05, 0.01)],
    ["BlowFlow.50", r.normal(30, 3)],
    ["AmbHumidity.50", r.normal(10, 1)],
    ["HumTemp.50", r.normal(30, 1)],
    ["HTubeTemp.50", r.normal(27, 1)],
    ["HTubePow.50", r.normal(40, 5)],
    ["HumPow.50", r.normal(35, 5)],
    // No oximeter: the machine writes -1.
    ["SpO2.50", Number.NaN],
    ["SpO2.95", Number.NaN],
    ["SpO2.Max", Number.NaN],
    ["SpO2Thresh", Number.NaN],
    ["MaskPress.50", quantile(mask, 0.5) + r.uniform(-0.3, 0.3)],
    ["MaskPress.95", quantile(mask, 0.95) + r.uniform(-0.3, 0.3)],
    ["MaskPress.Max", max(mask) + r.uniform(0.5, 2)],
    ["TgtIPAP.50", ipap50],
    ["TgtIPAP.95", ipap95],
    ["TgtIPAP.Max", ipapMax],
    ["TgtEPAP.50", ipap50 - epr],
    ["TgtEPAP.95", ipap95 - epr],
    ["TgtEPAP.Max", ipapMax - epr],
    ["Leak.50", quantile(leak, 0.5)],
    ["Leak.95", quantile(leak, 0.95)],
    ["Leak.70", quantile(leak, 0.7)],
    ["Leak.Max", max(leak) + r.uniform(0.04, 0.3)],
    ["MinVent.50", quantile(vent, 0.5)],
    ["MinVent.95", quantile(vent, 0.95)],
    ["MinVent.Max", max(vent) + r.uniform(0.5, 2)],
    ["RespRate.50", quantile(resp, 0.5)],
    ["RespRate.95", quantile(resp, 0.95) + r.uniform(0.4, 3)],
    ["RespRate.Max", max(resp) + r.uniform(2, 6)],
    ["TidVol.50", quantile(tidal, 0.5)],
    ["TidVol.95", quantile(tidal, 0.95)],
    ["TidVol.Max", max(tidal) + r.uniform(0.04, 0.2)],
    ["AHI", index(apneas + hypopneas)],
    ["HI", index(hypopneas)],
    ["AI", index(apneas)],
    ["OAI", index(count(["obstructive_apnea"]))],
    ["CAI", index(count(["central_apnea"]))],
    ["UAI", index(count(["unclassified_apnea"]))],
    ["RIN", index(count(["arousal"]))],
    ["CSR", 0],
    ["Fault.Device", 0],
    ["Fault.Alarm", 0],
    ["Fault.Humidifier", 0],
    ["Fault.HeatedTube", 0],
  ];

  return new Map(values.map(([label, value]) => [label, snapStr(label, value)]));
}
