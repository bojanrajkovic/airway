// Builds EDF bytes from literal field text, so the reader's tests never depend on the writer.

/** One signal's header fields, as text. */
export type SignalFields = {
  label: string;
  unit: string;
  physicalMin: string;
  physicalMax: string;
  digitalMin: string;
  digitalMax: string;
  samples: string;
};

/** The main header's fields, as text. `headerBytes` defaults to 256 per signal plus 256. */
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

/** A header's bytes. */
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

/** A header followed by `bodyBytes` zero bytes. */
export function file(fields: HeaderFields, bodyBytes: number): Uint8Array {
  const head = header(fields);
  const bytes = new Uint8Array(head.length + bodyBytes);

  bytes.set(head);

  return bytes;
}

/** A Flow signal: 0.02 L/s per step over -32768..32767, 2 samples per record. */
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

/** A two-signal plain EDF header with 6-byte records. */
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
