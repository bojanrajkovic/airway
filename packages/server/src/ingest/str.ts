import type { Result } from "neverthrow";
import type { StrDay } from "@airway/contract/derived/str";
import { decimalsForStep, round } from "@airway/contract/registry/units";
import { AIRSENSE, step, type DataLabel } from "@airway/edf/airsense";
import { STR_NIGHT_COLUMNS, STR_SETTINGS } from "@airway/edf/columns";
import { readEdf } from "@airway/edf/file";
import type { EdfReadError } from "@airway/edf/header";

/** Reports a record whose Date signal differs from the header's start date plus the record index. `date` is null when the machine wrote -1 as the Date. */
export type StrWarning = {
  kind: "date_mismatch";
  record: number;
  expected: Temporal.PlainDate;
  date: Temporal.PlainDate | null;
};

/** `readStr` returns STR.edf's days, oldest first, and a warning for each record whose Date signal differs from the record's expected date. */
export type StrFile = { days: StrDay[]; warnings: StrWarning[] };

type StrLabel = DataLabel<typeof AIRSENSE.str>;

const EPOCH = Temporal.PlainDate.from("1970-01-01");

/**
 * Reads STR.edf's records, one per day. A day's date is the header's start date plus the day's
 * record index. `readStr` adds a warning when a record's Date signal differs from that date.
 * A day is unused when OnDuration is -1.
 * Values are physical, rounded to their signal's step, and null where the machine wrote -1.
 * Unused MaskOn and MaskOff slots stay NaN because `buildSessions` expects NaN there.
 */
export function readStr(bytes: Uint8Array): Result<StrFile, EdfReadError> {
  return readEdf(bytes, AIRSENSE.str).map((file) => {
    const start = file.header.start.toPlainDate();
    const headers = new Map(file.signals.map((signal) => [signal.label, signal]));
    const values = file.samples;

    // Returns a signal's value in `record`, rounded to the step in that signal's header.
    const at = (label: StrLabel, record: number): number | null => {
      const value = values[label][record] ?? Number.NaN;
      const header = headers.get(label);

      return Number.isNaN(value) || header === undefined
        ? null
        : round(value, decimalsForStep(step(header)));
    };

    const slots = (label: StrLabel, record: number): number[] => {
      const per = headers.get(label)?.samplesPerRecord ?? 0;

      return [...values[label].subarray(record * per, (record + 1) * per)];
    };

    const records = Array.from({ length: file.records }, (_, record) => record);

    const days = records.map((record): StrDay => {
      const day = start.add({ days: record });

      if (at("OnDuration", record) === null) {
        return { day, used: false };
      }

      return {
        day,
        used: true,
        maskOn: slots("MaskOn", record),
        maskOff: slots("MaskOff", record),
        maskEvents: at("MaskEvents", record) ?? 0,
        signals: Object.fromEntries(
          STR_NIGHT_COLUMNS.map(([label, column]) => [column, at(label, record)]),
        ),
        settings: Object.fromEntries(
          STR_SETTINGS.map(([label, name]) => [name, at(label, record)]),
        ),
      };
    });

    const warnings = records.flatMap((record): StrWarning[] => {
      const expected = start.add({ days: record });
      const count = at("Date", record);
      const date = count === null ? null : EPOCH.add({ days: count });

      return date?.equals(expected) === true
        ? []
        : [{ kind: "date_mismatch", record, expected, date }];
    });

    return { days, warnings };
  });
}
