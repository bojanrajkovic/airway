// Reads whole EDF files back for the writer's and the synthetic files' tests, and assumes they're
// well formed. It stays
// separate from ingest's reader on purpose, so one misreading of the format can't pass both
// sides' tests.

const decoder = new TextDecoder();

export type ReadSignal = {
  label: string;
  unit: string;
  physicalMin: string;
  physicalMax: string;
  digitalMin: number;
  digitalMax: number;
  samplesPerRecord: number;
};

export type ReadFile = {
  version: string;
  patient: string;
  recording: string;
  startDate: string;
  startTime: string;
  headerBytes: number;
  reserved: string;
  records: number;
  recordDuration: string;
  signals: ReadSignal[];
  /** Each signal's stored int16 values across all records, by label. */
  digital: Map<string, Int16Array>;
};

export function readEdf(bytes: Uint8Array): ReadFile {
  let offset = 0;
  const text = (width: number): string => {
    const value = decoder.decode(bytes.subarray(offset, offset + width)).trimEnd();

    offset += width;

    return value;
  };

  const version = text(8);
  const patient = text(80);
  const recording = text(80);
  const startDate = text(8);
  const startTime = text(8);
  const headerBytes = Number(text(8));
  const reserved = text(44);
  const records = Number(text(8));
  const recordDuration = text(8);
  const count = Number(text(4));
  const column = (width: number): string[] => Array.from({ length: count }, () => text(width));

  const labels = column(16);
  column(80);
  const units = column(8);
  const physicalMins = column(8);
  const physicalMaxes = column(8);
  const digitalMins = column(8).map(Number);
  const digitalMaxes = column(8).map(Number);
  column(80);
  const samplesPerRecord = column(8).map(Number);
  const signals = labels.map((label, i): ReadSignal => ({
    label,
    unit: units[i] ?? "",
    physicalMin: physicalMins[i] ?? "",
    physicalMax: physicalMaxes[i] ?? "",
    digitalMin: digitalMins[i] ?? 0,
    digitalMax: digitalMaxes[i] ?? 0,
    samplesPerRecord: samplesPerRecord[i] ?? 0,
  }));

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const digital = new Map(
    signals.map((signal) => [signal.label, new Int16Array(records * signal.samplesPerRecord)]),
  );

  offset = headerBytes;
  for (let record = 0; record < records; record += 1) {
    for (const signal of signals) {
      const values = digital.get(signal.label);

      for (let i = 0; i < signal.samplesPerRecord; i += 1) {
        values?.set([view.getInt16(offset, true)], record * signal.samplesPerRecord + i);
        offset += 2;
      }
    }
  }

  return {
    version,
    patient,
    recording,
    startDate,
    startTime,
    headerBytes,
    reserved,
    records,
    recordDuration,
    signals,
    digital,
  };
}

export type ReadAnnotation = { onset: number; duration: number; label: string };

/** The annotations in an EDF+ file, without the timekeeping entries. */
export function readAnnotations(bytes: Uint8Array): ReadAnnotation[] {
  const file = readEdf(bytes);
  const [signal] = file.signals;
  const recordBytes = 2 * file.signals.reduce((sum, s) => sum + s.samplesPerRecord, 0);
  const annotationBytes = 2 * (signal?.samplesPerRecord ?? 0);
  const annotations: ReadAnnotation[] = [];

  for (let record = 0; record < file.records; record += 1) {
    const start = file.headerBytes + record * recordBytes;
    const text = decoder.decode(bytes.subarray(start, start + annotationBytes));

    // Each entry ends in \x14\0; an entry with no label after its times is timekeeping.
    for (const entry of text.split("\0").filter((part) => part.startsWith("+"))) {
      const [times = "", label] = entry.split("\x14");
      const [onset = "", duration = ""] = times.split("\x15");

      if (label !== undefined && label !== "") {
        annotations.push({ onset: Number(onset), duration: Number(duration), label });
      }
    }
  }

  return annotations;
}
