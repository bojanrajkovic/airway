import { describe, expect, it } from "vitest";
import { offsetForNight, type ClockOffset } from "@airway/contract/clock";
import type { DerivedRows } from "@airway/contract/derived/rows";
import { settingsChanges } from "@airway/contract/derived/settings";
import { isReadable, readHeader, recordBytes, type ReadableEdfFile } from "@airway/edf/header";
import type { EdgeCaseName } from "@airway/synthetic/cases";
import { maskSlots, strFile } from "@airway/synthetic/files";
import { syntheticNights, type Synthetic } from "@airway/synthetic/model";
import { synthesize } from "@airway/synthetic/synthesize";
import { readStr } from "../../src/ingest/str.ts";

const uploadedAt = Temporal.Instant.from("2030-03-01T12:00:00Z");

function readable(bytes: Uint8Array): ReadableEdfFile {
  const file = readHeader(bytes)._unsafeUnwrap();

  if (!isReadable(file)) {
    throw new Error("expected a readable STR.edf");
  }

  return file;
}

// STR.edf keeps 10 slots a day, with -1 (NaN) in those it didn't use.
const tenSlots = (slots: readonly number[]): number[] =>
  Array.from({ length: 10 }, (_, i) => slots[i] ?? Number.NaN);

// One edge case's STR.edf, and the rows synthetic expects ingest to derive from it.
type Case = Synthetic & { bytes: Uint8Array; rows: DerivedRows };

function edgeCase(name: EdgeCaseName): Case {
  const model = syntheticNights({ seed: 7, nights: 0, cases: [name] })._unsafeUnwrap();
  const bytes = strFile(model.nights, model.offsets)._unsafeUnwrap();
  const { rows } = synthesize(model.nights, model.offsets, {
    patient: "child",
    uploadedAt,
  })._unsafeUnwrap();

  return { ...model, bytes, rows };
}

describe("readStr", () => {
  it("reads used days' values and slots, and leaves unused days with their date", () => {
    const { nights, offsets, bytes, rows } = edgeCase("unused-days");
    const { days, warnings } = readStr(bytes, readable(bytes))._unsafeUnwrap();

    expect(warnings).toEqual([]);
    expect(days.map(({ day, used }) => [day.toString(), used])).toEqual(
      rows.daily_usage.map(({ day, usage }) => [day.toString(), usage > 0]),
    );

    const offset = (night: Temporal.PlainDate): ClockOffset =>
      offsetForNight(offsets, night)._unsafeUnwrap();

    for (const night of nights) {
      const day = days.find((record) => record.day.equals(night.night));
      const row = rows.nights.find((record) => record.night.equals(night.night));
      const { maskOn, maskOff } = maskSlots(night, offset(night.night));

      expect(day).toMatchObject({
        used: true,
        maskOn: tenSlots(maskOn),
        maskOff: tenSlots(maskOff),
        maskEvents: night.str.get("MaskEvents"),
        signals: row?.signals,
      });
    }
  });

  it("reads the settings that give synthetic's settings changes", () => {
    const { nights, bytes, rows } = edgeCase("settings-change");
    const { days } = readStr(bytes, readable(bytes))._unsafeUnwrap();
    const [first] = nights;

    if (first === undefined) {
      throw new Error("expected two nights");
    }

    expect(rows.settings_changes).toHaveLength(1);
    expect(settingsChanges(days, first.night)).toEqual(rows.settings_changes);
  });

  it("warns when a record's Date disagrees with its place in the file, and keeps its place", () => {
    const { bytes } = edgeCase("unused-days");
    const file = readable(bytes);
    const changed = bytes.slice();
    // Date is the first signal, so it's the first int16 of record 1.
    const at = file.header.headerBytes + recordBytes(file.header);

    new DataView(changed.buffer).setInt16(at, -1, true);

    const { days, warnings } = readStr(changed, file)._unsafeUnwrap();
    const expected = file.header.start.toPlainDate().add({ days: 1 });

    expect(days[1]?.day).toEqual(expected);
    expect(warnings).toEqual([{ kind: "date_mismatch", record: 1, expected, date: null }]);
  });
});
