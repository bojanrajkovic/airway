// Builds EDF bytes from literal field text, so the reader's tests never depend on the writer.

/** Describes one signal's header fields as text. */
export type SignalFields = {
  label: string;
  unit: string;
  physicalMin: string;
  physicalMax: string;
  digitalMin: string;
  digitalMax: string;
  samples: string;
};

/**
 * Describes the main header's fields as text. `headerBytes` defaults to 256 per signal plus 256.
 */
export type HeaderFields = {
  version?: string;
  patient?: string;
  recording?: string;
  startDate: string;
  startTime: string;
  headerBytes?: string;
  reserved: string;
  records: string;
  recordSeconds: string;
  signals: SignalFields[];
};

const encoder = new TextEncoder();

// Each field is left-aligned and padded with spaces to its width.
const pad = (value: string, width: number): string => value.padEnd(width, " ").slice(0, width);

/** Encodes `fields` as the bytes of an EDF header. */
export function header(fields: HeaderFields): Uint8Array {
  const { signals } = fields;
  const column = (width: number, value: (signal: SignalFields) => string): string =>
    signals.map((signal) => pad(value(signal), width)).join("");
  const text = [
    pad(fields.version ?? "0", 8),
    pad(fields.patient ?? "X X X X", 80),
    pad(fields.recording ?? "", 80),
    pad(fields.startDate, 8),
    pad(fields.startTime, 8),
    pad(fields.headerBytes ?? (256 * (signals.length + 1)).toString(), 8),
    pad(fields.reserved, 44),
    pad(fields.records, 8),
    pad(fields.recordSeconds, 8),
    pad(signals.length.toString(), 4),
    column(16, (s) => s.label),
    column(80, () => ""),
    column(8, (s) => s.unit),
    column(8, (s) => s.physicalMin),
    column(8, (s) => s.physicalMax),
    column(8, (s) => s.digitalMin),
    column(8, (s) => s.digitalMax),
    column(80, () => ""),
    column(8, (s) => s.samples),
    column(32, () => ""),
  ].join("");

  return encoder.encode(text);
}

/** Returns the header for `fields`, followed by `bodyBytes` zero bytes. */
export function file(fields: HeaderFields, bodyBytes: number): Uint8Array {
  const head = header(fields);
  const bytes = new Uint8Array(head.length + bodyBytes);

  bytes.set(head);

  return bytes;
}

/**
 * Defines a Flow signal that stores 0.02 L/s per step over -32768..32767, with 2 samples per
 * record.
 */
export const flow: SignalFields = {
  label: "Flow.40ms",
  unit: "L/s",
  physicalMin: "-655.36",
  physicalMax: "655.34",
  digitalMin: "-32768",
  digitalMax: "32767",
  samples: "2",
};

export const crc16: SignalFields = {
  label: "Crc16",
  unit: "",
  physicalMin: "-32768",
  physicalMax: "32767",
  digitalMin: "-32768",
  digitalMax: "32767",
  samples: "1",
};

/** Returns the fields of a plain EDF header with two signals and 6-byte records. */
export const plain = (overrides: Partial<HeaderFields> = {}): HeaderFields => ({
  recording: "Startdate 07-JAN-2030 X X X",
  startDate: "07.01.30",
  startTime: "21.15.04",
  reserved: "EDF",
  records: "2",
  recordSeconds: "60.00",
  signals: [flow, crc16],
  ...overrides,
});

/**
 * Returns the header for `fields`, followed by `records` as int16 samples. Each record lists its
 * samples in the order of the header's signals.
 */
export function withSamples(fields: HeaderFields, records: number[][]): Uint8Array {
  const head = header(fields);
  const samples = records.flat();
  const bytes = new Uint8Array(head.length + 2 * samples.length);
  const view = new DataView(bytes.buffer);

  bytes.set(head);
  samples.forEach((sample, i) => {
    view.setInt16(head.length + 2 * i, sample, true);
  });

  return bytes;
}

/** Returns an annotation signal with `samples` int16 samples per record. Each sample is 2 bytes. */
export const annotationSignal = (samples: number): SignalFields => ({
  label: "EDF Annotations",
  unit: "",
  physicalMin: "-1",
  physicalMax: "1",
  digitalMin: "-32768",
  digitalMax: "32767",
  samples: samples.toString(),
});

// Sets the number of annotation bytes in each record of annotated().
const TAL_BYTES = 64;

/** Returns the fields of an EDF+D header with a 64-byte annotation signal and a Crc16 signal. */
export const annotated = (records: number): HeaderFields =>
  plain({
    reserved: "EDF+D",
    records: records.toString(),
    recordSeconds: "0.00",
    signals: [annotationSignal(TAL_BYTES / 2), crc16],
  });

// The Crc16 bytes are the text "+1". A reader that runs past the annotation bytes would misread
// them as a TAL.
const CRC = [0x2b, 0x31];

/** Returns an annotation file. Each record is TAL text zero-padded to 64 bytes, then a Crc16. */
export function withTals(fields: HeaderFields, records: string[]): Uint8Array {
  const head = header(fields);
  const size = TAL_BYTES + CRC.length;
  const bytes = new Uint8Array(head.length + size * records.length);

  bytes.set(head);
  records.forEach((text, i) => {
    const start = head.length + size * i;

    bytes.set(encoder.encode(text).subarray(0, TAL_BYTES), start);
    bytes.set(CRC, start + TAL_BYTES);
  });

  return bytes;
}
