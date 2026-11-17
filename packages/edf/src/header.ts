import { err, ok, Result } from "neverthrow";
import { checkFileSize, type FileSizeCheck } from "./size.ts";

/** One signal as a file header declares it. */
export type SignalHeader = {
  label: string;
  /** Empty when the header leaves the unit blank. */
  unit: string;
  /** The header's text, exactly as the machine writes it: `0.00` for some signals, `0` for others. */
  physicalMin: string;
  physicalMax: string;
  /** The range of the int16 values stored in the file. */
  digitalMin: number;
  digitalMax: number;
  samplesPerRecord: number;
};

/** What an EDF or EDF+ header says. Transducer and prefiltering fields are blank on the card. */
export type EdfHeader = {
  /** The reserved field: `EDF` for plain EDF, `EDF+C` or `EDF+D` for EDF+. */
  format: "EDF" | "EDF+C" | "EDF+D";
  /** The device clock's time, which has no zone, as the machine writes it. */
  start: Temporal.PlainDateTime;
  patient: string;
  recording: string;
  headerBytes: number;
  /** -1 when the card never filled it in. */
  declaredRecords: number;
  recordSeconds: number;
  /** In header order. */
  signals: readonly SignalHeader[];
};

/** Something the header says that disagrees with itself, without stopping the read. */
export type EdfWarning = {
  kind: "startdate_mismatch";
  /** The header's start date. */
  header: Temporal.PlainDate;
  /** The `Startdate` in the recording field. */
  startdate: Temporal.PlainDate;
};

export type EdfReadError =
  /** `bytes` ends before the header does; `headerBytes` is how many it needs, 256 when unknown. */
  | { kind: "header_too_short"; headerBytes: number }
  | { kind: "bad_field"; field: string; value: string }
  | { kind: "read_failed"; path: string; message: string };

/** A parsed header, the file's size verdict, and any warnings. */
export type EdfFile = { header: EdfHeader; size: FileSizeCheck; warnings: EdfWarning[] };

/** A file whose size verdict is `read`, so it has whole records to decode. */
export type ReadableEdfFile = EdfFile & { size: Extract<FileSizeCheck, { verdict: "read" }> };

export const isReadable = (file: EdfFile): file is ReadableEdfFile => file.size.verdict === "read";

/** The bytes in one data record, Crc16 included. */
export const recordBytes = (file: { signals: readonly SignalHeader[] }): number =>
  2 * file.signals.reduce((sum, signal) => sum + signal.samplesPerRecord, 0);

const FIXED_BYTES = 256;
const SIGNAL_BYTES = 256;
const FORMATS: readonly string[] = ["EDF", "EDF+C", "EDF+D"] satisfies EdfHeader["format"][];
const isFormat = (value: string): value is EdfHeader["format"] => FORMATS.includes(value);
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
// Latin-1 maps every byte to a character, so a stray high byte can't fail the decode.
const decoder = new TextDecoder("latin1");

/** Reads fixed-width, space-padded text fields in order. */
class FieldReader {
  #offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  text(width: number): string {
    const value = decoder.decode(this.bytes.subarray(this.#offset, this.#offset + width)).trim();

    this.#offset += width;

    return value;
  }

  number(field: string, width: number, integer = true): Result<number, EdfReadError> {
    return parseNumber(field, this.text(width), integer);
  }

  // EDF stores each field for every signal before the next field.
  column(count: number, width: number): string[] {
    return Array.from({ length: count }, () => this.text(width));
  }
}

const badField = (field: string, value: string): EdfReadError => ({
  kind: "bad_field",
  field,
  value,
});

function parseNumber(field: string, value: string, integer = true): Result<number, EdfReadError> {
  const parsed = Number(value);
  const valid = value !== "" && (integer ? Number.isInteger(parsed) : Number.isFinite(parsed));

  return valid ? ok(parsed) : err(badField(field, value));
}

// EDF+'s rule for its two-digit years: 85 to 99 are 19xx, the rest 20xx.
const fullYear = (yy: number): number => (yy >= 85 ? 1900 + yy : 2000 + yy);

function parseStart(date: string, time: string): Result<Temporal.PlainDateTime, EdfReadError> {
  const d = /^(\d\d)\.(\d\d)\.(\d\d)$/v.exec(date);
  const t = /^(\d\d)\.(\d\d)\.(\d\d)$/v.exec(time);

  if (d === null) {
    return err(badField("start date", date));
  }

  if (t === null) {
    return err(badField("start time", time));
  }

  const fields = {
    year: fullYear(Number(d[3])),
    month: Number(d[2]),
    day: Number(d[1]),
    hour: Number(t[1]),
    minute: Number(t[2]),
    second: Number(t[3]),
  };

  return Result.fromThrowable(
    () => Temporal.PlainDateTime.from(fields, { overflow: "reject" }),
    () => badField("start", `${date} ${time}`),
  )();
}

// EDF+ starts the recording field with "Startdate 07-JAN-2030". Null when it doesn't.
function startdate(recording: string): Temporal.PlainDate | null {
  const match = /^Startdate (\d\d)-([A-Z]{3})-(\d{4})(?: |$)/v.exec(recording);
  const month = MONTHS.indexOf(match?.[2] ?? "") + 1;

  if (match === null || month === 0) {
    return null;
  }

  return Result.fromThrowable(
    () =>
      Temporal.PlainDate.from(
        { year: Number(match[3]), month, day: Number(match[1]) },
        { overflow: "reject" },
      ),
    () => null,
  )().unwrapOr(null);
}

function parseSignals(reader: FieldReader, count: number): Result<SignalHeader[], EdfReadError> {
  const labels = reader.column(count, 16);
  reader.column(count, 80); // transducer
  const units = reader.column(count, 8);
  const physicalMins = reader.column(count, 8);
  const physicalMaxes = reader.column(count, 8);
  const digitalMins = reader.column(count, 8);
  const digitalMaxes = reader.column(count, 8);
  reader.column(count, 80); // prefiltering
  const samples = reader.column(count, 8);

  return Result.combine(
    labels.map((label, i): Result<SignalHeader, EdfReadError> => {
      const text = (column: string[]): string => column[i] ?? "";
      const integer = (field: string, column: string[]): Result<number, EdfReadError> =>
        parseNumber(`${label} ${field}`, text(column));
      // Kept as text, so it round-trips exactly; parsed only to check it's a number.
      const physical = (field: string, column: string[]): Result<string, EdfReadError> =>
        parseNumber(`${label} ${field}`, text(column), false).map(() => text(column));

      return Result.combine([
        physical("physical minimum", physicalMins),
        physical("physical maximum", physicalMaxes),
        integer("digital minimum", digitalMins),
        integer("digital maximum", digitalMaxes),
        integer("samples per record", samples),
      ]).andThen(([physicalMin, physicalMax, digitalMin, digitalMax, samplesPerRecord]) =>
        // An empty digital range would make every step a division by zero.
        digitalMax > digitalMin && samplesPerRecord > 0
          ? ok({
              label,
              unit: text(units),
              physicalMin,
              physicalMax,
              digitalMin,
              digitalMax,
              samplesPerRecord,
            })
          : err(
              badField(
                `${label} digital range`,
                `${digitalMin.toString()} to ${digitalMax.toString()}`,
              ),
            ),
      );
    }),
  );
}

/**
 * Parses an EDF or EDF+ header and checks the file's size against it.
 *
 * `bytes` must hold at least the whole header; `size` is the file's size on disk, which defaults
 * to `bytes.length` for a caller that read the whole file. A caller reading only the header reads
 * 256 bytes first; `header_too_short` then says how many the full header takes.
 */
export function readHeader(bytes: Uint8Array, size = bytes.length): Result<EdfFile, EdfReadError> {
  if (bytes.length < FIXED_BYTES) {
    return err({ kind: "header_too_short", headerBytes: FIXED_BYTES });
  }

  const reader = new FieldReader(bytes);
  const version = reader.text(8);
  const patient = reader.text(80);
  const recording = reader.text(80);
  const date = reader.text(8);
  const time = reader.text(8);

  return Result.combine([
    reader.number("header bytes", 8),
    // Plain EDF leaves the reserved field blank; the card writes "EDF" there.
    ok(reader.text(44).replace(/^$/v, "EDF")),
    reader.number("records", 8),
    reader.number("record duration", 8, false),
    reader.number("signals", 4),
  ])
    .andThen(([headerBytes, format, declaredRecords, recordSeconds, count]) => {
      if (version !== "0") {
        return err(badField("version", version));
      }

      if (!isFormat(format)) {
        return err(badField("reserved", format));
      }

      if (declaredRecords < -1) {
        return err(badField("records", declaredRecords.toString()));
      }

      if (recordSeconds < 0) {
        return err(badField("record duration", recordSeconds.toString()));
      }

      if (count < 1 || headerBytes !== FIXED_BYTES + SIGNAL_BYTES * count) {
        return err(badField("header bytes", headerBytes.toString()));
      }

      if (bytes.length < headerBytes) {
        return err({ kind: "header_too_short" as const, headerBytes });
      }

      return Result.combine([parseStart(date, time), parseSignals(reader, count)]).map(
        ([start, signals]): EdfHeader => ({
          format,
          start,
          patient,
          recording,
          headerBytes,
          declaredRecords,
          recordSeconds,
          signals,
        }),
      );
    })
    .map((header): EdfFile => {
      const stated = startdate(header.recording);
      const date = header.start.toPlainDate();
      const warnings: EdfWarning[] =
        stated !== null && !stated.equals(date)
          ? [{ kind: "startdate_mismatch", header: date, startdate: stated }]
          : [];
      const check = checkFileSize({
        size,
        headerBytes: header.headerBytes,
        recordBytes: recordBytes(header),
        declaredRecords: header.declaredRecords,
      });

      return { header, size: check, warnings };
    });
}
