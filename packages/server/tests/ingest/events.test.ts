import { describe, expect, it } from "vitest";
import type { Session } from "@airway/contract/derived/sessions";
import { EventSource, SessionSource } from "@airway/contract/derived/values";
import { readHeader } from "@airway/edf/header";
import { EdgeCaseName } from "@airway/synthetic/cases";
import { scoreNight, toEvents, type FileAnnotations } from "../../src/ingest/events.ts";
import { caseNight, editEve, folderContext, writeFolder } from "../support/cpap-folder.ts";

const night = Temporal.PlainDate.from("2030-01-07");
const start = Temporal.Instant.from("2030-01-08T02:00:00Z");
const sessions: Session[] = [
  { session: 1, start, end: start.add({ hours: 4 }), source: SessionSource.Str },
];
const file = (
  path: string,
  offsetSeconds: number,
  annotations: { onset: number; duration: number; label: string }[],
): FileAnnotations => ({ path, start: start.add({ seconds: offsetSeconds }), annotations });

describe("toEvents", () => {
  it("ignores case when mapping labels to event types, drops Recording starts, and turns an unknown label into an event of type other that keeps the label's text", () => {
    const placed = toEvents(
      night,
      [
        file("a_EVE.edf", 0, [
          { onset: 0, duration: 0, label: "Recording starts" },
          { onset: 100, duration: 20, label: "OBSTRUCTIVE APNEA" },
          { onset: 200, duration: 15, label: "central apnea" },
          { onset: 300, duration: 12, label: "Apnea" },
          { onset: 400, duration: 0, label: "Hypopnea" },
          { onset: 500, duration: 0, label: "Arousal" },
          { onset: 600, duration: 0, label: "Snore" },
        ]),
      ],
      sessions,
    );

    expect(placed.events.map(({ type, label }) => [type, label])).toEqual([
      ["obstructive_apnea", "OBSTRUCTIVE APNEA"],
      ["central_apnea", "central apnea"],
      ["unclassified_apnea", "Apnea"],
      ["hypopnea", "Hypopnea"],
      ["arousal", "Arousal"],
      ["other", "Snore"],
    ]);
    expect(placed.unknownLabels).toEqual([{ label: "Snore", path: "a_EVE.edf", count: 1 }]);
  });

  it("starts an event with a duration at its onset minus that duration, and starts an event with a duration of 0 at its onset", () => {
    const placed = toEvents(
      night,
      [
        file("a_EVE.edf", 30, [
          { onset: 100, duration: 20, label: "Obstructive Apnea" },
          { onset: 200, duration: 0, label: "Hypopnea" },
        ]),
      ],
      sessions,
    );

    expect(placed.events.map(({ ts, duration }) => [ts, duration])).toEqual([
      [start.add({ seconds: 110 }), 20],
      [start.add({ seconds: 230 }), null],
    ]);
  });

  it("merges the events from the night's EVE files in time order and places each event in its session", () => {
    const placed = toEvents(
      night,
      [
        file("b_EVE.edf", 3600, [{ onset: 10, duration: 0, label: "Hypopnea" }]),
        file("a_EVE.edf", 0, [
          { onset: 10, duration: 0, label: "Hypopnea" },
          // This event starts five hours in, an hour after the only session ends.
          { onset: 18_000, duration: 0, label: "Hypopnea" },
        ]),
      ],
      sessions,
    );

    expect(
      placed.events.map(({ ts, session, outside_mask_on }) => [ts, session, outside_mask_on]),
    ).toEqual([
      [start.add({ seconds: 10 }), 1, false],
      [start.add({ seconds: 3610 }), 1, false],
      [start.add({ seconds: 18_000 }), 1, true],
    ]);
    expect(
      placed.events.every(
        ({ night: date, source }) => date.equals(night) && source === EventSource.Resmed,
      ),
    ).toBe(true);
  });
});

describe("scoreNight", () => {
  it("reads all three EVE files and builds the event rows and night row that the synthetic case expects", async () => {
    const { input, files, rows } = caseNight(EdgeCaseName.SplitFiles);
    const ctx = folderContext(await writeFolder(files));

    expect(input.files).toHaveLength(3);

    const scored = (await scoreNight(ctx, input))._unsafeUnwrap();
    const expected = rows.nights.find(({ night: n }) => n.equals(input.night));

    expect(scored.events).toEqual(rows.events.filter((row) => row.night.equals(input.night)));
    expect({ ...scored.row, arrived_at: expected?.arrived_at }).toEqual(expected);
    expect(scored.ahi.outcome).toBe("match");
  });

  it("scores a night with a header-only EVE file the same as the night without that file", async () => {
    const { input, files } = caseNight(EdgeCaseName.SplitFiles);
    const wholeCtx = folderContext(await writeFolder(files));
    const whole = (await scoreNight(wholeCtx, input))._unsafeUnwrap();
    const counts = await Promise.all(
      input.files.map(
        async (file) =>
          (await scoreNight(wholeCtx, { ...input, files: [file] }))._unsafeUnwrap().events.length,
      ),
    );
    // Picks an EVE file with events, so emptying it removes events from the night.
    const target = input.files[counts.findIndex((count) => count > 0)];
    const rest = input.files.filter((file) => file !== target);
    // An empty EVE file on the card is only a header, and the record count at byte 236 is -1.
    const headerOnly = (bytes: Uint8Array): Uint8Array => {
      const copy = bytes.slice(0, readHeader(bytes)._unsafeUnwrap().header.headerBytes);

      copy.set(new TextEncoder().encode("-1".padEnd(8)), 236);

      return copy;
    };

    const emptied = files.map((f) =>
      f.path === target?.path ? { ...f, bytes: headerOnly(f.bytes) } : f,
    );
    const edf = readHeader(emptied.find((f) => f.path === target?.path)?.bytes ?? new Uint8Array());
    const ctx = folderContext(await writeFolder(emptied));
    const eveFiles =
      target === undefined ? rest : [{ ...target, edf: edf._unsafeUnwrap() }, ...rest];
    const scored = (await scoreNight(ctx, { ...input, files: eveFiles }))._unsafeUnwrap();
    const withoutIt = (await scoreNight(ctx, { ...input, files: rest }))._unsafeUnwrap();

    expect(edf._unsafeUnwrap().size.verdict).toBe("skip");
    expect(scored.events).toEqual(withoutIt.events);
    expect(scored.events.length).toBeLessThan(whole.events.length);
  });

  it("fails the night when an EVE file's annotations don't parse", async () => {
    const { input, files } = caseNight(EdgeCaseName.SplitFiles);
    // Replaces the leading "+" of the first time-stamped annotation list with "x". An onset must start with "+" or "-".
    const corrupt = (bytes: Uint8Array): Uint8Array => {
      const copy = bytes.slice();
      const { headerBytes } = readHeader(bytes)._unsafeUnwrap().header;

      copy[copy.indexOf(0x2b, headerBytes)] = 0x78;

      return copy;
    };

    const ctx = folderContext(await writeFolder(editEve(files, corrupt)));

    expect((await scoreNight(ctx, input))._unsafeUnwrapErr()).toMatchObject({
      kind: "bad_annotation",
      path: input.files[0]?.path,
    });
  });
});
