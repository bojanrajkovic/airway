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

/** Something the header contradicts without stopping the read. */
export type EdfWarning =
  /** The recording field's `Startdate` names a different day from the header's start date. */
  { kind: "startdate_mismatch"; headerDate: Temporal.PlainDate; startdate: Temporal.PlainDate };

export type EdfReadError =
  /** `bytes` ends before the header does; `headerBytes` is how many it needs, 256 when unknown. */
  | { kind: "header_too_short"; headerBytes: number }
  | { kind: "bad_field"; field: string; value: string }
  | { kind: "read_failed"; path: string; message: string }
  | { kind: "missing_signal"; label: string }
  | { kind: "range_out_of_bounds"; fromRecord: number; toRecord: number; records: number }
  /** `bytes` ends before the file's last record, as when a caller passes only the header. */
  | { kind: "bytes_too_short"; needed: number; got: number }
  | { kind: "no_annotations" }
  /** A TAL that doesn't follow EDF+'s grammar, in the record it came from. */
  | { kind: "bad_annotation"; record: number; tal: string };

/** A parsed header, `checkFileSize`'s result for the file, and any warnings. */
export type EdfFile = { header: EdfHeader; size: FileSizeCheck; warnings: EdfWarning[] };

/** A file that `checkFileSize` says to read, so it has whole records to decode. */
export type ReadableEdfFile = EdfFile & { size: Extract<FileSizeCheck, { verdict: "read" }> };

export const isReadable = (file: EdfFile): file is ReadableEdfFile => file.size.verdict === "read";

/** Checks that `bytes` reach the end of record `toRecord`, exclusive. */
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

/** Whether a numeric field must be a whole number. */
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

  /** Reads a number; `field` names it in a `bad_field` error. */
  readNumber(
    field: string,
    width: number,
    kind: NumberKind = "integer",
  ): Result<number, EdfReadError> {
    return parseNumber(field, this.readString(width), kind);
  }

  /**
   * Reads one field for every signal: EDF stores each field for all signals before the next.
   * With `parse`, each signal's text is parsed, and the first failure is returned.
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
  const labels = reader.readColumn(count, 16);
  const name = (signal: number, field: string): string => `${labels[signal] ?? ""} ${field}`;
  const integer =
    (field: string) =>
    (text: string, signal: number): Result<number, EdfReadError> =>
      parseNumber(name(signal, field), text);
  // Kept as text, so it round-trips exactly; parsed only to check it's a number.
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

          // An empty digital range would make every step a division by zero.
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
