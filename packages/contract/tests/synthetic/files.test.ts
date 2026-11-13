import { describe, expect, it } from "vitest";
import { ClockOffsets } from "../../src/clock.ts";
import { nightFiles, strFile, type NightFile } from "../../src/synthetic/files.ts";
import { syntheticNights } from "../../src/synthetic/model.ts";
import { readAnnotations, readEdf } from "../edf/test-reader.ts";

// The second entry starts on the third night, so nights 1-2 and 3-4 use different offsets.
const offsets = ClockOffsets.parse([
  { from: "2030-01-01", utcOffset: "-05:00" },
  { from: "2030-01-09", utcOffset: "-04:00" },
]);
const nights = syntheticNights({ seed: 7, nights: 4 });
const [first, , third] = nights;

const files = (night: (typeof nights)[number] | undefined): NightFile[] =>
  night === undefined ? [] : nightFiles(night, offsets)._unsafeUnwrap();

const deviceTime = (at: Temporal.Instant, utcOffset: string): Temporal.PlainDateTime =>
  at.toZonedDateTimeISO(utcOffset).toPlainDateTime();

describe("nightFiles", () => {
  const written = files(first);

  it("writes a BRP, PLD, and SAD file per segment, and one EVE and CSL pair", () => {
    const kinds = written.map((file) => file.kind);

    expect(kinds.filter((kind) => kind === "brp")).toHaveLength(first?.segments.length ?? -1);
    expect(kinds.filter((kind) => kind === "pld")).toHaveLength(first?.segments.length ?? -1);
    expect(kinds.filter((kind) => kind === "sad")).toHaveLength(first?.segments.length ?? -1);
    expect(kinds.filter((kind) => kind === "eve" || kind === "csl")).toEqual(["eve", "csl"]);
  });

  it.each([
    ["the first offset", first, "-05:00"],
    ["the second offset", third, "-04:00"],
  ])("starts files on the device clock with %s", (_case, night, utcOffset) => {
    const [segment] = night?.segments ?? [];
    const [brp, pld] = files(night);

    expect(segment).toBeDefined();
    expect(brp?.start).toEqual(segment?.start.toZonedDateTimeISO(utcOffset).toPlainDateTime());
    expect(pld?.start).toEqual(brp?.start.add({ seconds: 1 }));
    expect(readEdf(brp?.bytes ?? new Uint8Array(256)).startTime).toBe(
      brp?.start.toPlainTime().toString().replaceAll(":", "."),
    );
  });

  it("writes one 60 s record per minute of each segment", () => {
    const [segment] = first?.segments ?? [];
    const brp = written.find((file) => file.kind === "brp");
    const minutes = segment === undefined ? -1 : segment.start.until(segment.end).total("minutes");

    expect(readEdf(brp?.bytes ?? new Uint8Array(256)).records).toBe(minutes);
  });

  it("puts each event's end in EVE, after the recording-start annotation", () => {
    const eve = written.find((file) => file.kind === "eve");
    const start = first?.segments[0]?.start;
    const expected = (first?.events ?? []).map((event) => ({
      onset: Math.round((start?.until(event.at).total("seconds") ?? 0) + event.duration),
      duration: event.duration,
    }));
    const annotations = readAnnotations(eve?.bytes ?? new Uint8Array(256));

    expect(annotations[0]?.label).toBe("Recording starts");
    expect(annotations.slice(1).map(({ onset, duration }) => ({ onset, duration }))).toEqual(
      expected,
    );
  });

  it("writes SAD as missing throughout", () => {
    const sad = written.find((file) => file.kind === "sad");
    const pulse = readEdf(sad?.bytes ?? new Uint8Array(256)).digital.get("Pulse.1s");

    expect(pulse?.every((value) => value === -1)).toBe(true);
  });
});

describe("strFile", () => {
  // Leaving out the second night makes it an unused day.
  const read = readEdf(
    strFile(
      nights.filter((_night, i) => i !== 1 && i !== 3),
      offsets,
    )._unsafeUnwrap(),
  );
  const date = read.digital.get("Date");
  const maskOn = read.digital.get("MaskOn");

  it("has one record per day from the first night to the last, with all 81 signals", () => {
    expect(read.records).toBe(3);
    expect(read.signals).toHaveLength(81);
  });

  it("writes an unused day as -1 throughout", () => {
    expect(date?.[1]).toBe(-1);
    expect([...(maskOn?.subarray(10, 20) ?? [])].every((value) => value === -1)).toBe(true);
  });

  it("counts Date in days since 1970 and mask-on slots in device minutes since noon", () => {
    const period = third?.periods[0];
    const noon = third?.night.toPlainDateTime("12:00");
    const minutes =
      period === undefined || noon === undefined
        ? -1
        : Math.floor(noon.until(deviceTime(period.on, "-04:00")).total("minutes"));

    expect(date?.[2]).toBe(Temporal.PlainDate.from("1970-01-01").until("2030-01-09").days);
    expect(maskOn?.[20]).toBe(minutes);
    expect(maskOn?.[20 + (third?.periods.length ?? 0)]).toBe(-1);
  });

  it("writes the same file whatever order the nights come in", () => {
    const sorted = strFile(nights, offsets)._unsafeUnwrap();

    expect(strFile([...nights].reverse(), offsets)._unsafeUnwrap()).toEqual(sorted);
  });

  it("refuses an empty list of nights", () => {
    expect(strFile([], offsets)._unsafeUnwrapErr()).toEqual({ kind: "no_nights" });
  });
});
