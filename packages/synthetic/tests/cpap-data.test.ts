import { crc32 } from "node:zlib";
import { test as base, describe, expect } from "vitest";
import { cpapData, type CpapFile } from "../src/cpap-data.ts";
import { DEVICE } from "../src/files.ts";
import { syntheticNights, type SyntheticNight } from "../src/model.ts";

const zone = "America/New_York";
const { nights } = syntheticNights({ seed: 7, nights: 3 })._unsafeUnwrap();

// Builds a new `folder` from `nights` for every test that takes `folder`.
const test = base.extend<{ folder: CpapFile[] }>({
  folder: async ({}, use) => {
    await use(cpapData(nights, zone)._unsafeUnwrap());
  },
});

const pathsOf = (folder: readonly CpapFile[]): string[] => folder.map((file) => file.path);
const bytesOf = (folder: readonly CpapFile[]): Map<string, Uint8Array> =>
  new Map(folder.map((file) => [file.path, file.bytes]));

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
  test("writes the top-level files once", ({ folder }) => {
    expect(pathsOf(folder).filter((path) => !path.startsWith("DATALOG/"))).toEqual([
      "Identification.tgt",
      "Identification.crc",
      "STR.edf",
    ]);
  });

  test.for(nights.map((night) => [night.night.toString(), night] as const))(
    "for %s, writes a BRP, PLD, and SAD file per segment, one EVE file, one CSL file, and a .crc for every .edf file",
    ([, night], { folder }) => {
      const inFolder = pathsOf(folder).filter((path) => path.startsWith(nightFolder(night)));
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

  test("puts a segment that starts after midnight in the night's folder and names its files by the device-clock start", ({
    folder,
  }) => {
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
    expect(pathsOf(folder)).toContain(
      `${night === undefined ? "" : nightFolder(night)}${stamp ?? ""}_BRP.edf`,
    );
  });

  test("writes two little-endian CRC-32s to each DATALOG .crc file, the first over the .edf file's first 256 bytes and the second over the remaining bytes", ({
    folder,
  }) => {
    const byPath = bytesOf(folder);
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

  test("writes Identification.tgt with the keys in the card's order and the same serial number as the EDF files", ({
    folder,
  }) => {
    const byPath = bytesOf(folder);
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

  test("leaves out the folder of a night with no segments", () => {
    const [first, ...rest] = nights;
    const empty: CpapFile[] = cpapData(
      [...(first === undefined ? [] : [{ ...first, segments: [], eventFiles: [] }]), ...rest],
      zone,
    )._unsafeUnwrap();

    expect(
      empty.some((file) => first !== undefined && file.path.startsWith(nightFolder(first))),
    ).toBe(false);
  });
});
