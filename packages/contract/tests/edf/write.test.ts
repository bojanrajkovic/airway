import { describe, expect, it } from "vitest";
import { AIRSENSE, type EdfFile } from "../../src/edf/airsense.ts";
import { writeAnnotations, writeSignals, type EdfHeader } from "../../src/edf/write.ts";
import { readAnnotations, readEdf } from "@airway/testing/edf";

const header: EdfHeader = {
  start: Temporal.PlainDateTime.from("2030-01-07T22:15:03"),
  patient: "X X X Synthetic",
  recording: "Startdate 07-JAN-2030 X X SYNTHETIC-0001",
};

// Constant values for every signal of a file, enough for `records` records.
function filled(file: EdfFile, records: number, value = 1): Map<string, Float64Array> {
  return new Map(
    file.signals
      .filter((signal) => signal.label !== "Crc16")
      .map((signal) => [
        signal.label,
        new Float64Array(records * signal.samplesPerRecord).fill(value),
      ]),
  );
}

// CRC-16/CCITT-FALSE, bit by bit, as an independent check on the writer's table-driven one.
function ccittFalse(bytes: Uint8Array): number {
  let crc = 0xff_ff;

  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80_00) !== 0 ? ((crc << 1) ^ 0x10_21) & 0xff_ff : (crc << 1) & 0xff_ff;
    }
  }

  return crc;
}

const ascii = (bytes: Uint8Array, from: number, width: number): string =>
  new TextDecoder().decode(bytes.subarray(from, from + width));

describe("writeSignals", () => {
  const bytes = writeSignals(AIRSENSE.pld, header, filled(AIRSENSE.pld, 3))._unsafeUnwrap();

  it("puts the main header fields at their offsets, padded with spaces", () => {
    expect(ascii(bytes, 0, 8)).toBe("0       ");
    expect(ascii(bytes, 168, 16)).toBe("07.01.3022.15.03");
    expect(ascii(bytes, 184, 8)).toBe("2816    ");
    expect(ascii(bytes, 192, 44)).toBe("EDF".padEnd(44));
    expect(ascii(bytes, 236, 8)).toBe("3       ");
    expect(ascii(bytes, 244, 8)).toBe("60.00   ");
    expect(ascii(bytes, 252, 4)).toBe("10  ");
  });

  it("writes the signal headers as the list declares them", () => {
    const read = readEdf(bytes);

    expect(AIRSENSE.pld.signals).toMatchObject(read.signals);
  });

  it("is exactly the header plus the records", () => {
    const recordBytes = 2 * (9 * 30 + 1);

    expect(bytes.length).toBe(2816 + 3 * recordBytes);
  });

  it("pads text by bytes, so a UTF-8 °C keeps the next fields in place", () => {
    const str = writeSignals(AIRSENSE.str, header, filled(AIRSENSE.str, 1))._unsafeUnwrap();
    const read = readEdf(str);
    const temp = read.signals.find((signal) => signal.label === "S.Temp");

    expect(temp).toMatchObject({ unit: "°C", physicalMin: "16.00", digitalMax: 300 });
    expect(read.signals.at(-1)?.label).toBe("Crc16");
  });

  it("rounds to the step and clamps to the digital range", () => {
    const values = filled(AIRSENSE.brp, 1, 0);
    const flow = values.get("Flow.40ms");

    flow?.set([0.1234, -5, 9]);
    const read = readEdf(writeSignals(AIRSENSE.brp, header, values)._unsafeUnwrap());

    // Flow's step is 0.002 L/s, and 0 L/s is digital 0.
    expect([...(read.digital.get("Flow.40ms")?.subarray(0, 3) ?? [])]).toEqual([62, -1000, 1500]);
  });

  it("writes NaN as -1 where -1 is outside the digital range", () => {
    const values = filled(AIRSENSE.sad, 1, Number.NaN);
    const read = readEdf(writeSignals(AIRSENSE.sad, header, values)._unsafeUnwrap());

    expect(read.digital.get("Pulse.1s")?.every((value) => value === -1)).toBe(true);
  });

  it.each([
    ["a missing signal", (v: Map<string, Float64Array>) => v.delete("Leak.2s"), "missing_signal"],
    [
      "a partial record",
      (v: Map<string, Float64Array>) => v.set("Leak.2s", new Float64Array(31)),
      "partial_record",
    ],
    [
      "signals with different record counts",
      (v: Map<string, Float64Array>) => v.set("Leak.2s", new Float64Array(60)),
      "uneven_signals",
    ],
  ])("refuses %s", (_case, edit, kind) => {
    const values = filled(AIRSENSE.pld, 3);

    edit(values);

    expect(writeSignals(AIRSENSE.pld, header, values)._unsafeUnwrapErr().kind).toBe(kind);
  });

  it("ends each record with the CRC-16/CCITT-FALSE of its bytes, as the machine does", () => {
    expect(ccittFalse(new TextEncoder().encode("123456789"))).toBe(0x29_b1);

    const recordBytes = 2 * (9 * 30 + 1);

    for (let record = 0; record < 3; record += 1) {
      const start = 2816 + record * recordBytes;
      const body = bytes.subarray(start, start + recordBytes - 2);
      const stored = new DataView(bytes.buffer).getUint16(start + recordBytes - 2, true);

      expect(stored).toBe(ccittFalse(body));
    }
  });

  it("refuses NaN where -1 is a real value, since it would read back as one", () => {
    const values = filled(AIRSENSE.brp, 1, 0);

    values.get("Flow.40ms")?.set([Number.NaN]);

    expect(writeSignals(AIRSENSE.brp, header, values)._unsafeUnwrapErr()).toEqual({
      kind: "missing_not_representable",
      label: "Flow.40ms",
    });
  });

  it("refuses text longer than its field", () => {
    const long = { ...header, patient: "x".repeat(81) };

    expect(writeSignals(AIRSENSE.pld, long, filled(AIRSENSE.pld, 1))._unsafeUnwrapErr()).toEqual({
      kind: "field_too_long",
      field: "patient",
      value: long.patient,
    });
  });
});

describe("writeAnnotations", () => {
  const annotations = [
    { onset: 0, duration: 0, label: "Recording starts" },
    { onset: 12_345, duration: 18, label: "Obstructive Apnea" },
    { onset: 20_000, duration: 9, label: "Hypopnea" },
  ];
  const bytes = writeAnnotations(AIRSENSE.eve, header, annotations)._unsafeUnwrap();

  it("writes one annotation per record that reads back unchanged", () => {
    expect(readAnnotations(bytes)).toEqual(annotations);
    expect(readEdf(bytes)).toMatchObject({ reserved: "EDF+D", records: 3, recordDuration: "0.00" });
  });

  it("is exactly the header plus 40-byte records", () => {
    expect(bytes.length).toBe(768 + 3 * 40);
  });

  it("refuses an annotation that doesn't fit one record", () => {
    // 39 bytes with the timekeeping entry; a record holds 38.
    const long = { onset: 1_234_567.75, duration: 30, label: "Obstructive Apnea" };

    expect(writeAnnotations(AIRSENSE.eve, header, [long])._unsafeUnwrapErr()).toEqual({
      kind: "annotation_too_long",
      annotation: long,
    });
  });
});
