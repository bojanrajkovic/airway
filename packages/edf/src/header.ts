import { err, ok, Result } from "neverthrow";
import { checkFileSize, type FileSizeCheck } from "./size.ts";

/** Describes one signal with the values that the file header declares for it. */
export type SignalHeader<L extends string = string> = {
  label: L;
  /** Contains an empty string when the header leaves the unit blank. */
  unit: string;
  /** Stores the header's text exactly as the machine writes it, such as `0.00` or `0`. */
  physicalMin: string;
  physicalMax: string;
  /** `digitalMin` and `digitalMax` bound the int16 values stored in the file. */
  digitalMin: number;
  digitalMax: number;
  samplesPerRecord: number;
};

/**
 * `readHeader` parses these fields from an EDF or EDF+ header. It skips the transducer and
 * prefiltering fields, which the card leaves blank.
 */
export type EdfHeader = {
  /** The reserved field reads `EDF` for plain EDF and `EDF+C` or `EDF+D` for EDF+. */
  format: "EDF" | "EDF+C" | "EDF+D";
  /** The machine writes the start time from the device clock, without a time zone. */
  start: Temporal.PlainDateTime;
  patient: string;
  recording: string;
  headerBytes: number;
  /** Equals -1 when the machine never filled in the record count. */
  declaredRecords: number;
  recordSeconds: number;
  /** Contains each signal's header fields, in header order. */
  signals: readonly SignalHeader[];
};

/** `readHeader` reports a contradiction in the header as a warning and keeps reading. */
export type EdfWarning =
  /** The recording field's `Startdate` names a different day from the header's start date. */
  { kind: "startdate_mismatch"; headerDate: Temporal.PlainDate; startdate: Temporal.PlainDate };

export type EdfReadError =
  /**
   * `bytes` ends before the header ends. `headerBytes` is the header's length, or 256 when `bytes`
   * is shorter than 256 bytes.
   */
  | { kind: "header_too_short"; headerBytes: number }
  | { kind: "bad_field"; field: string; value: string }
  | { kind: "read_failed"; path: string; message: string }
  | { kind: "missing_signal"; label: string }
  | { kind: "range_out_of_bounds"; fromRecord: number; toRecord: number; records: number }
  /** `bytes` ends before the file's last record, as when a caller passes only the header. */
  | { kind: "bytes_too_short"; needed: number; got: number }
  | { kind: "no_annotations" }
  /**
   * `tal` is a time-stamped annotation list (TAL) that breaks EDF+'s grammar. `record` is the
   * number of the record that contains it.
   */
  | { kind: "bad_annotation"; record: number; tal: string };

/**
 * `readHeader` returns the parsed header, the result of `checkFileSize` for the file, and any
 * warnings.
 */
export type EdfFile = { header: EdfHeader; size: FileSizeCheck; warnings: EdfWarning[] };

/** `checkFileSize` says to read this file, so the file has whole records to decode. */
export type ReadableEdfFile = EdfFile & { size: Extract<FileSizeCheck, { verdict: "read" }> };

export const isReadable = (file: EdfFile): file is ReadableEdfFile => file.size.verdict === "read";

/** Checks that `bytes` covers every record before `toRecord`. */
export function coversRecords(
  bytes: Uint8Array,
  header: EdfHeader,
  toRecord: number,
): Result<void, EdfReadError> {
  const needed = header.headerBytes + toRecord * recordBytes(header);

  return bytes.length >= needed
    ? ok(undefined)
    : err({ kind: "bytes_too_short", needed, got: bytes.length });
}

/** Returns the number of bytes in one data record, including the Crc16. */
export const recordBytes = (file: { signals: readonly SignalHeader[] }): number =>
  2 * file.signals.reduce((sum, signal) => sum + signal.samplesPerRecord, 0);

const FIXED_BYTES = 256;
const SIGNAL_BYTES = 256;
const FORMATS: readonly string[] = ["EDF", "EDF+C", "EDF+D"] satisfies EdfHeader["format"][];
const isFormat = (value: string): value is EdfHeader["format"] => FORMATS.includes(value);
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
// The machine writes header text as UTF-8. The decoder replaces a byte that isn't valid UTF-8 with
// U+FFFD, so a stray byte can't fail the decode.
const decoder = new TextDecoder();

/** Sets whether `readNumber` accepts only a whole number or also a decimal. */
type NumberKind = "integer" | "decimal";

/** Reads a header's fixed-width, space-padded text fields in order. */
class FieldReader {
  #offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  readString(width: number): string {
    const value = decoder.decode(this.bytes.subarray(this.#offset, this.#offset + width)).trim();

    this.#offset += width;

    return value;
  }

  /** Reads a numeric field. `field` is the name that a `bad_field` error reports. */
  readNumber(
    field: string,
    width: number,
    kind: NumberKind = "integer",
  ): Result<number, EdfReadError> {
    return parseNumber(field, this.readString(width), kind);
  }

  /**
   * Reads one field for every signal. The signal headers list every signal's label, then every
   * signal's transducer, and so on for each field.
   * Given `parse`, `readColumn` parses each signal's text and returns the first failure.
   */
  readColumn(signals: number, width: number): string[];
  readColumn<T>(
    signals: number,
    width: number,
    parse: (text: string, signal: number) => Result<T, EdfReadError>,
  ): Result<T[], EdfReadError>;
  readColumn<T>(
    signals: number,
    width: number,
    parse?: (text: string, signal: number) => Result<T, EdfReadError>,
  ): string[] | Result<T[], EdfReadError> {
    const texts = Array.from({ length: signals }, () => this.readString(width));

    return parse === undefined ? texts : Result.combine(texts.map(parse));
  }
}

const badField = (field: string, value: string): EdfReadError => ({
  kind: "bad_field",
  field,
  value,
});

function parseNumber(
  field: string,
  text: string,
  kind: NumberKind = "integer",
): Result<number, EdfReadError> {
  const value = Number(text);
  const valid =
    text !== "" && (kind === "integer" ? Number.isInteger(value) : Number.isFinite(value));

  return valid ? ok(value) : err(badField(field, text));
}

// EDF+ reads two-digit years 85 to 99 as 19xx and the rest as 20xx.
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

// EDF+ starts the recording field with "Startdate 07-JAN-2030". Returns null for any other
// recording field.
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
  const labels = reader.readColumn(count, 16);
  const name = (signal: number, field: string): string => `${labels[signal] ?? ""} ${field}`;
  const integer =
    (field: string) =>
    (text: string, signal: number): Result<number, EdfReadError> =>
      parseNumber(name(signal, field), text);
  // Keeps each physical value as text so that it round-trips exactly, and parses the text only to
  // check that it's a number.
  const physical =
    (field: string) =>
    (text: string, signal: number): Result<string, EdfReadError> =>
      parseNumber(name(signal, field), text, "decimal").map(() => text);

  reader.readColumn(count, 80); // transducer
  const units = reader.readColumn(count, 8);
  const physicalMins = reader.readColumn(count, 8, physical("physical minimum"));
  const physicalMaxes = reader.readColumn(count, 8, physical("physical maximum"));
  const digitalMins = reader.readColumn(count, 8, integer("digital minimum"));
  const digitalMaxes = reader.readColumn(count, 8, integer("digital maximum"));
  reader.readColumn(count, 80); // prefiltering
  const samples = reader.readColumn(count, 8, integer("samples per record"));

  return Result.combine([physicalMins, physicalMaxes, digitalMins, digitalMaxes, samples]).andThen(
    ([physicalMin, physicalMax, digitalMin, digitalMax, samplesPerRecord]) =>
      Result.combine(
        labels.map((label, i): Result<SignalHeader, EdfReadError> => {
          const signal = {
            label,
            unit: units[i] ?? "",
            physicalMin: physicalMin[i] ?? "",
            physicalMax: physicalMax[i] ?? "",
            digitalMin: digitalMin[i] ?? 0,
            digitalMax: digitalMax[i] ?? 0,
            samplesPerRecord: samplesPerRecord[i] ?? 0,
          };

          // Scaling a sample divides by the digital range, so an empty range would divide by zero.
          return signal.digitalMax > signal.digitalMin && signal.samplesPerRecord > 0
            ? ok(signal)
            : err(
                badField(
                  `${label} digital range`,
                  `${signal.digitalMin.toString()} to ${signal.digitalMax.toString()}`,
                ),
              );
        }),
      ),
  );
}

/**
 * Parses an EDF or EDF+ header and checks the file's size against it. `bytes` must contain the
 * whole header. `size` is the file's size on disk, and defaults to `bytes.length`.
 */
export function readHeader(bytes: Uint8Array, size = bytes.length): Result<EdfFile, EdfReadError> {
  if (bytes.length < FIXED_BYTES) {
    return err({ kind: "header_too_short", headerBytes: FIXED_BYTES });
  }

  const reader = new FieldReader(bytes);
  const version = reader.readString(8);
  const patient = reader.readString(80);
  const recording = reader.readString(80);
  const date = reader.readString(8);
  const time = reader.readString(8);

  return Result.combine([
    reader.readNumber("header bytes", 8),
    // Plain EDF leaves the reserved field blank; the card writes "EDF" there.
    ok(reader.readString(44).replace(/^$/v, "EDF")),
    reader.readNumber("records", 8),
    reader.readNumber("record duration", 8, "decimal"),
    reader.readNumber("signals", 4),
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
          ? [{ kind: "startdate_mismatch", headerDate: date, startdate: stated }]
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
