import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ClockOffsets } from "@airway/contract/clock";
import { cpapData, type CpapFile } from "../src/cpap-data.ts";
import { DEVICE } from "../src/files.ts";
import { syntheticNights, type SyntheticNight } from "../src/model.ts";

const offsets = ClockOffsets.parse([{ from: "2030-01-01", utcOffset: "-05:00" }]);
const nights = syntheticNights({ seed: 7, nights: 3 });
const folder = cpapData(nights, offsets)._unsafeUnwrap();
const paths = folder.map((file) => file.path);
const byPath = new Map(folder.map((file) => [file.path, file.bytes]));

const littleEndian = (...values: number[]): Uint8Array => {
  const bytes = new Uint8Array(4 * values.length);
  const view = new DataView(bytes.buffer);

  values.forEach((value, i) => {
    view.setUint32(4 * i, value, true);
  });

  return bytes;
};

const nightFolder = (night: SyntheticNight): string =>
  `DATALOG/${night.night.toString().replaceAll("-", "")}/`;

describe("cpapData", () => {
  it("writes the top-level files once", () => {
    expect(paths.filter((path) => !path.startsWith("DATALOG/"))).toEqual([
      "Identification.tgt",
      "Identification.crc",
      "STR.edf",
    ]);
  });

  it.each(nights.map((night) => [night.night.toString(), night] as const))(
    "gives %s a BRP, PLD, and SAD per segment, one EVE and CSL, and a .crc for each",
    (_date, night) => {
      const inFolder = paths.filter((path) => path.startsWith(nightFolder(night)));
      const count = (suffix: string): number =>
        inFolder.filter((path) => path.endsWith(suffix)).length;

      for (const kind of ["BRP", "PLD", "SAD"]) {
        expect(count(`_${kind}.edf`)).toBe(night.segments.length);
        expect(count(`_${kind}.crc`)).toBe(night.segments.length);
      }

      for (const kind of ["EVE", "CSL"]) {
        expect(count(`_${kind}.edf`)).toBe(1);
        expect(count(`_${kind}.crc`)).toBe(1);
      }
    },
  );

  it("names files by their device-clock start, in the night's folder after midnight too", () => {
    const night = nights.find((n) =>
      n.segments.some(
        (s) => s.start.toZonedDateTimeISO("-05:00").toPlainDate().day !== n.night.day,
      ),
    );
    const late = night?.segments.find(
      (s) => s.start.toZonedDateTimeISO("-05:00").toPlainDate().day !== night.night.day,
    );
    const start = late?.start.toZonedDateTimeISO("-05:00").toPlainDateTime();
    const stamp = start?.toString().replaceAll("-", "").replaceAll(":", "").replace("T", "_");

    expect(night).toBeDefined();
    expect(paths).toContain(
      `${night === undefined ? "" : nightFolder(night)}${stamp ?? ""}_BRP.edf`,
    );
  });

  it("checksums each night file's first 256 bytes and its rest, little-endian", () => {
    const edfs = folder.filter(
      (file) => file.path.startsWith("DATALOG/") && file.path.endsWith(".edf"),
    );

    expect(edfs.length).toBeGreaterThan(0);

    for (const { path, bytes } of edfs) {
      expect(byPath.get(path.replace(/\.edf$/v, ".crc"))).toEqual(
        littleEndian(crc32(bytes.subarray(0, 256)), crc32(bytes.subarray(256))),
      );
    }
  });

  it("writes Identification.tgt in the card's layout, with the files' serial", () => {
    const tgt = byPath.get("Identification.tgt") ?? new Uint8Array();
    const text = new TextDecoder().decode(tgt);
    const keys = [...text.matchAll(/\r\n#(\w+) /gv)].map((match) => match[1]);

    expect(keys).toEqual([
      "IMF",
      "VIR",
      "RIR",
      "PVR",
      "PVD",
      "CID",
      "RID",
      "VID",
      "SRN",
      "SID",
      "PNA",
      "PCD",
      "PCB",
      "MID",
      "FGT",
      "BID",
    ]);
    expect(text).toContain(`\r\n#SRN ${DEVICE.serial}\n`);
    expect(text).toContain(`\r\n#PNA ${DEVICE.model}\n`);
    expect(byPath.get("Identification.crc")).toEqual(littleEndian(crc32(tgt)));
  });

  it("returns the writer's error for a night before the first clock offset", () => {
    const early = ClockOffsets.parse([{ from: "2031-01-01", utcOffset: "-05:00" }]);

    expect(cpapData(nights, early)._unsafeUnwrapErr().kind).toBe("before_first_offset");
  });

  it("leaves out the folder of a night with no segments", () => {
    const [first, ...rest] = nights;
    const empty: CpapFile[] = cpapData(
      [...(first === undefined ? [] : [{ ...first, segments: [] }]), ...rest],
      offsets,
    )._unsafeUnwrap();

    expect(
      empty.some((file) => first !== undefined && file.path.startsWith(nightFolder(first))),
    ).toBe(false);
  });
});
