import { random, type Segment, type SyntheticNight } from "./model.ts";

/** One breath, with times in seconds from the segment's start and its volume in litres. */
export type Breath = { start: number; inhale: number; exhale: number; volume: number };

/** BRP's two 25 Hz signals for one segment, in L/s and cmH2O. */
export type BrpSignals = { flow: Float64Array; pressure: Float64Array };

const HZ = 25;
const PLD_SECONDS = 2;
// The share of a breath spent breathing in.
const INHALE = 0.4;
// A hypopnea shrinks breaths to this share of their volume.
const HYPOPNEA_VOLUME = 0.4;
// A breath squeezed into less than this share of its length before a pause is folded into the
// previous breath's exhale instead.
const SHORTEST_FIT = 0.25;
// Flow noise is uniform within this many L/s, which bounds flow during a pause: under the
// pediatric step's 0.01 L/s threshold, and under 5% of a child's breath. Uniform because a draw
// per 25 Hz sample is the generator's busiest loop, and a Gaussian draw costs several times more.
const NOISE = 0.002;

type Window = { from: number; to: number };

const offset = (segment: Segment, at: Temporal.Instant): number =>
  segment.start.until(at).total("seconds");

type Windows = { pauses: Window[]; hypopneas: Window[] };

// The pauses and hypopneas inside a segment, in seconds from its start.
function windows(segment: Segment, night: Pick<SyntheticNight, "events" | "pauses">): Windows {
  const length = offset(segment, segment.end);
  const inside = ({ from, to }: Window): boolean => from >= 0 && to <= length;
  const window = ({ at, duration }: { at: Temporal.Instant; duration: number }): Window => {
    const from = offset(segment, at);

    return { from, to: from + duration };
  };

  return {
    pauses: night.pauses
      .map(window)
      .filter(inside)
      .sort((a, b) => a.from - b.from),
    hypopneas: night.events
      .filter((event) => event.type === "hypopnea")
      .map(window)
      .filter(inside),
  };
}

/**
 * The segment's breaths. Each breath's length follows the 2 s breathing rate at its start, and
 * its volume the 2 s tidal volume, shrunk during a hypopnea. No breath crosses a pause, so each
 * pause lasts exactly as long as the model says.
 */
export function breaths(
  segment: Segment,
  night: Pick<SyntheticNight, "events" | "pauses">,
): Breath[] {
  const rate = segment.pld.get("RespRate.2s") ?? new Float64Array();
  const tidal = segment.pld.get("TidVol.2s") ?? new Float64Array();
  const length = offset(segment, segment.end);
  const { pauses, hypopneas } = windows(segment, night);
  const result: Breath[] = [];
  let time = 0;
  let volume = 0;

  while (time < length) {
    const index = Math.floor(time / PLD_SECONDS);
    const pause = pauses.find(({ to }) => to > time);
    const nextStop = Math.min(pause?.from ?? length, length);
    const seconds = 60 / (rate[index] ?? 15);

    if (pause !== undefined && time >= pause.from) {
      time = pause.to;
      continue;
    }

    // During a stop the 2 s volume is 0; breaths around it keep the last real volume.
    volume = (tidal[index] ?? 0) > 0 ? (tidal[index] ?? 0) : volume;
    const room = nextStop - time;
    const previous = result.at(-1);

    if (room < SHORTEST_FIT * seconds && previous !== undefined) {
      previous.exhale += room;
      time = nextStop;
      continue;
    }

    const fitted = Math.min(seconds, room);
    const shrink = hypopneas.some(({ from, to }) => time >= from && time < to);
    // A breath shortened to fit before a pause moves less air, so its peak stays normal.
    const share = fitted / seconds;

    result.push({
      start: time,
      inhale: INHALE * fitted,
      exhale: (1 - INHALE) * fitted,
      volume: share * (shrink ? HYPOPNEA_VOLUME * volume : volume),
    });
    time += fitted;
  }

  return result;
}

/**
 * Renders a segment's 25 Hz flow and pressure. Each breath is a half sine wave in and a half
 * sine wave out, sized so the inhale moves the breath's volume. Pressure follows the 2 s
 * pressure, dropping to the EPR pressure while breathing out. The segment's seed makes the noise
 * the same every time.
 */
export function renderBrp(
  segment: Segment,
  night: Pick<SyntheticNight, "events" | "pauses">,
): BrpSignals {
  const r = random(segment.seed);
  const count = Math.round(offset(segment, segment.end) * HZ);
  const flow = new Float64Array(count);
  const pressure = new Float64Array(count);
  const inhalePressure = segment.pld.get("Press.2s") ?? new Float64Array();
  const exhalePressure = segment.pld.get("EprPress.2s") ?? new Float64Array();

  for (let i = 0; i < count; i += 1) {
    flow[i] = r.uniform(-NOISE, NOISE);
    pressure[i] = inhalePressure[Math.floor(i / HZ / PLD_SECONDS)] ?? 0;
  }

  for (const { start, inhale, exhale, volume } of breaths(segment, night)) {
    // The area under a half sine of height h over t seconds is 2ht/π.
    const inHeight = (Math.PI * volume) / (2 * inhale);
    const outHeight = (Math.PI * volume) / (2 * exhale);
    const last = Math.min(count, Math.ceil((start + inhale + exhale) * HZ));

    for (let i = Math.ceil(start * HZ); i < last; i += 1) {
      const t = i / HZ - start;
      const breathingIn = t < inhale;

      flow[i] =
        (flow[i] ?? 0) +
        (breathingIn
          ? inHeight * Math.sin((Math.PI * t) / inhale)
          : -outHeight * Math.sin((Math.PI * (t - inhale)) / exhale));

      if (!breathingIn) {
        pressure[i] = exhalePressure[Math.floor(i / HZ / PLD_SECONDS)] ?? pressure[i] ?? 0;
      }
    }
  }

  return { flow, pressure };
}
