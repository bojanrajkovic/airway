import { describe, expect, it } from "vitest";
import { nightFiles, strFile, writtenDuration, type NightFile } from "../src/files.ts";
import { syntheticNights } from "../src/model.ts";
import { readBackAnnotations, readBackEdf } from "@airway/testing/edf-readback";

const zone = "America/New_York";
const { nights } = syntheticNights({ seed: 7, nights: 4 })._unsafeUnwrap();
const [first, , third] = nights;

const files = (night: (typeof nights)[number] | undefined): NightFile[] =>
  night === undefined ? [] : nightFiles(night, zone)._unsafeUnwrap();

describe("nightFiles", () => {
  const written = files(first);

  it("writes a BRP, PLD, and SAD file per segment, and one EVE and CSL pair", () => {
    const kinds = written.map((file) => file.kind);

    expect(kinds.filter((kind) => kind === "brp")).toHaveLength(first?.segments.length ?? -1);
    expect(kinds.filter((kind) => kind === "pld")).toHaveLength(first?.segments.length ?? -1);
    expect(kinds.filter((kind) => kind === "sad")).toHaveLength(first?.segments.length ?? -1);
    expect(kinds.filter((kind) => kind === "eve" || kind === "csl")).toEqual(["eve", "csl"]);
  });

  it("starts files on the device clock, at the zone's winter offset", () => {
    const [segment] = first?.segments ?? [];
    const [brp, pld] = written;

    expect(segment).toBeDefined();
    expect(brp?.start).toEqual(segment?.start.toZonedDateTimeISO("-05:00").toPlainDateTime());
    expect(pld?.start).toEqual(brp?.start.add({ seconds: 1 }));
    expect(readBackEdf(brp?.bytes ?? new Uint8Array(256)).startTime).toBe(
      brp?.start.toPlainTime().toString().replaceAll(":", "."),
    );
  });

  it("writes one 60 s record per minute of each segment", () => {
    const [segment] = first?.segments ?? [];
    const brp = written.find((file) => file.kind === "brp");
    const minutes = segment === undefined ? -1 : segment.start.until(segment.end).total("minutes");

    expect(readBackEdf(brp?.bytes ?? new Uint8Array(256)).records).toBe(minutes);
  });

  it("puts each event's end in EVE, after the recording-start annotation", () => {
    const eve = written.find((file) => file.kind === "eve");
    const start = first?.eventFiles[0]?.start;
    const expected = (first?.events ?? []).map((event) => ({
      onset: Math.round((start?.until(event.at).total("seconds") ?? 0) + event.duration),
      duration: writtenDuration(event),
    }));
    const annotations = readBackAnnotations(eve?.bytes ?? new Uint8Array(256));

    expect(annotations[0]?.label).toBe("Recording starts");
    expect(annotations.slice(1).map(({ onset, duration }) => ({ onset, duration }))).toEqual(
      expected,
    );
  });

  it("writes a 0 duration for hypopneas and arousals, and a duration of at least 10 s for apneas", () => {
    const eve = written.find((file) => file.kind === "eve");
    const annotations = readBackAnnotations(eve?.bytes ?? new Uint8Array(256)).slice(1);
    const byLabel = (labels: readonly string[]): number[] =>
      annotations.filter(({ label }) => labels.includes(label)).map(({ duration }) => duration);

    expect(byLabel(["Hypopnea", "Arousal"])).not.toHaveLength(0);
    expect(byLabel(["Hypopnea", "Arousal"]).every((duration) => duration === 0)).toBe(true);
    expect(byLabel(["Obstructive Apnea", "Central Apnea", "Apnea"])).not.toHaveLength(0);
    expect(
      byLabel(["Obstructive Apnea", "Central Apnea", "Apnea"]).every((duration) => duration >= 10),
    ).toBe(true);
  });

  it("puts each event in the last EVE file starting before it, measured from that file", () => {
    const split = first?.events[Math.floor(first.events.length / 2)]?.at;
    const eventFiles = [
      ...(first?.eventFiles ?? []),
      { start: split ?? Temporal.Instant.fromEpochMilliseconds(0), withCsl: false },
    ];
    const edited = first === undefined ? undefined : { ...first, eventFiles };
    const eves = files(edited).filter((file) => file.kind === "eve");
    const later = (first?.events ?? []).filter(
      (event) => split !== undefined && Temporal.Instant.compare(event.at, split) >= 0,
    );
    const onsets = readBackAnnotations(eves[1]?.bytes ?? new Uint8Array(256))
      .slice(1)
      .map(({ onset }) => onset);

    expect(eves).toHaveLength(2);
    expect(files(edited).filter((file) => file.kind === "csl")).toHaveLength(1);
    expect(onsets).toEqual(
      later.map((event) =>
        Math.round((split?.until(event.at).total("seconds") ?? 0) + event.duration),
      ),
    );
  });

  it("writes SAD as missing throughout", () => {
    const sad = written.find((file) => file.kind === "sad");
    const pulse = readBackEdf(sad?.bytes ?? new Uint8Array(256)).digital.get("Pulse.1s");

    expect(pulse?.every((value) => value === -1)).toBe(true);
  });
});

describe("strFile", () => {
  // Leaving out the second night makes it an unused day.
  const read = readBackEdf(
    strFile(
      nights.filter((_night, i) => i !== 1 && i !== 3),
      zone,
    )._unsafeUnwrap(),
  );
  const date = read.digital.get("Date");
  const maskOn = read.digital.get("MaskOn");

  it("has one record per day from the first night to the last, with all 81 signals", () => {
    expect(read.records).toBe(3);
    expect(read.signals).toHaveLength(81);
  });

  it("writes -1 for every value of an unused day except its Date", () => {
    expect(date?.[1]).toBe(Temporal.PlainDate.from("1970-01-01").until("2030-01-08").days);
    expect(read.digital.get("OnDuration")?.[1]).toBe(-1);
    expect([...(maskOn?.subarray(10, 20) ?? [])].every((value) => value === -1)).toBe(true);
  });

  it("counts Date in days since 1970 and mask-on slots in device minutes since noon", () => {
    const period = third?.periods[0];
    const noon = third?.night.toPlainDateTime("12:00");
    const minutes =
      period === undefined || noon === undefined
        ? -1
        : Math.floor(
            noon.until(period.on.toZonedDateTimeISO("-05:00").toPlainDateTime()).total("minutes"),
          );

    expect(date?.[2]).toBe(Temporal.PlainDate.from("1970-01-01").until("2030-01-09").days);
    expect(maskOn?.[20]).toBe(minutes);
    expect(maskOn?.[20 + (third?.periods.length ?? 0)]).toBe(-1);
  });

  it("writes the same file whatever order the nights come in", () => {
    const sorted = strFile(nights, zone)._unsafeUnwrap();

    expect(strFile([...nights].reverse(), zone)._unsafeUnwrap()).toEqual(sorted);
  });

  it("refuses an empty list of nights", () => {
    expect(strFile([], zone)._unsafeUnwrapErr()).toEqual({ kind: "no_nights" });
  });
});
