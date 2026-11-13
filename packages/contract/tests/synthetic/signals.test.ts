import { describe, expect, it } from "vitest";
import { syntheticNights, type SyntheticNight } from "../../src/synthetic/model.ts";
import { breaths, renderBrp } from "../../src/synthetic/signals.ts";

const HZ = 25;
// The pediatric step smooths flow with a 5-sample average, then counts crossings of 0.01 L/s.
const THRESHOLD = 0.01;

// A night with a pause of each kind, so every kind gets rendered.
const night = syntheticNights({ seed: 7, nights: 30 }).find((candidate) => {
  const kinds = new Set(candidate.pauses.map((pause) => pause.kind));

  return kinds.size === 3;
});
const episodes: Pick<SyntheticNight, "events" | "pauses"> = night ?? { events: [], pauses: [] };
const segments = night?.segments ?? [];

const lowest = (values: Float64Array): number => values.reduce((a, b) => Math.min(a, b), Infinity);
const highest = (values: Float64Array): number =>
  values.reduce((a, b) => Math.max(a, b), -Infinity);

function upCrossings(flow: Float64Array): number {
  let crossings = 0;
  let previous = 0;

  for (let i = 0; i < flow.length; i += 1) {
    const window = flow.subarray(Math.max(0, i - 2), i + 3);
    const value = window.reduce((sum, sample) => sum + sample, 0) / window.length;

    crossings += i > 0 && value >= THRESHOLD && previous < THRESHOLD ? 1 : 0;
    previous = value;
  }

  return crossings;
}

describe("renderBrp", () => {
  it("has a night with every kind of pause to render", () => {
    expect(night).toBeDefined();
  });

  it.each(segments.map((segment) => [segment.start.toString(), segment] as const))(
    "%s: flow and pressure stay in range, with one up-crossing per breath, give or take one",
    (_start, segment) => {
      const { flow, pressure } = renderBrp(segment, episodes);

      expect(lowest(flow)).toBeGreaterThanOrEqual(-2);
      expect(highest(flow)).toBeLessThanOrEqual(3);
      expect(lowest(pressure)).toBeGreaterThanOrEqual(0);
      expect(highest(pressure)).toBeLessThanOrEqual(40);
      expect(Math.abs(upCrossings(flow) - breaths(segment, episodes).length)).toBeLessThanOrEqual(
        1,
      );
    },
  );

  // A breath shortened to fit before a pause must not keep its full volume, or its peak spikes.
  it("keeps every breath's peak flow near the segment's typical peak", () => {
    for (const segment of segments) {
      const peaks = breaths(segment, episodes)
        .filter(({ volume }) => volume > 0)
        .map(({ inhale, volume }) => (Math.PI * volume) / (2 * inhale));
      const sorted = [...peaks].sort((a, b) => a - b);
      const typical = sorted[Math.floor(sorted.length / 2)] ?? 0;

      expect(Math.max(...peaks)).toBeLessThan(1.5 * typical);
    }
  });

  it("holds flow under 5% of a breath, and under the crossing threshold, through every pause", () => {
    for (const segment of segments) {
      const { flow } = renderBrp(segment, episodes);
      const peaks = breaths(segment, episodes)
        .map(({ inhale, volume }) => (Math.PI * volume) / (2 * inhale))
        .sort((a, b) => a - b);
      const baseline = peaks[Math.floor(peaks.length / 2)] ?? 0;
      const length = segment.start.until(segment.end).total("seconds");

      for (const pause of episodes.pauses) {
        const from = segment.start.until(pause.at).total("seconds");

        if (from >= 0 && from + pause.duration <= length) {
          const during = flow.subarray(
            Math.ceil(from * HZ),
            Math.floor((from + pause.duration) * HZ),
          );
          const peak = highest(during.map(Math.abs));

          expect(peak).toBeLessThan(Math.min(THRESHOLD, 0.05 * baseline));
        }
      }
    }
  });

  it("renders the same segment the same way every time", () => {
    const [segment] = segments;

    expect(segment).toBeDefined();
    if (segment !== undefined) {
      expect(renderBrp(segment, episodes)).toEqual(renderBrp(segment, episodes));
    }
  });
});
