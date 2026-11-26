import { crc32 } from "node:zlib";
import { Result } from "neverthrow";
import { DEVICE, nightFiles, strFile, type NightFile, type SyntheticFileError } from "./files.ts";
import type { SyntheticNight } from "./model.ts";

/**
 * Describes a file in the CPAP data folder. `path` starts at the folder's root, and `bytes` is
 * the file's contents.
 */
export type CpapFile = { path: string; bytes: Uint8Array };

// An SD card's Identification.tgt lists these keys in this order. Ingest reads only #SRN and #PNA,
// so the other values are placeholders.
const IDENTIFICATION: readonly (readonly [string, string])[] = [
  ["IMF", "0001"],
  ["VIR", "0000"],
  ["RIR", "0000"],
  ["PVR", "0000"],
  ["PVD", "0000"],
  ["CID", "0000"],
  ["RID", "0000"],
  ["VID", "0000"],
  ["SRN", DEVICE.serial],
  ["SID", "0000"],
  ["PNA", DEVICE.model],
  ["PCD", "0000"],
  ["PCB", "0000"],
  ["MID", "0000"],
  ["FGT", "0000"],
  ["BID", "0000"],
];

const encoder = new TextEncoder();

const littleEndian = (...values: number[]): Uint8Array => {
  const bytes = new Uint8Array(4 * values.length);
  const view = new DataView(bytes.buffer);

  values.forEach((value, i) => {
    view.setUint32(4 * i, value, true);
  });

  return bytes;
};

const compact = (date: Temporal.PlainDate): string => date.toString().replaceAll("-", "");

// Names a file after its start on the device clock and its kind, as in 20300107_213412_BRP.
const fileName = ({ kind, start }: NightFile): string =>
  `${compact(start.toPlainDate())}_${start.toPlainTime().toString().replaceAll(":", "").slice(0, 6)}_${kind.toUpperCase()}`;

/**
 * Extends `NightFile` with the file's DATALOG path. `path` starts at the folder's root and leaves
 * off the .edf extension.
 */
export type DatalogFile = NightFile & { path: string };

/** Returns a night's EDF files in `nightFiles` order and adds each file's DATALOG path. */
export function datalogFiles(
  night: SyntheticNight,
  zone: string,
): Result<DatalogFile[], SyntheticFileError> {
  return nightFiles(night, zone).map((files) =>
    files.map((file) => ({ ...file, path: `DATALOG/${compact(night.night)}/${fileName(file)}` })),
  );
}

/**
 * Returns every file in the folder: Identification.tgt and its .crc, STR.edf, and each night file
 * with its .crc.
 */
export function folderFiles(str: Uint8Array, datalog: readonly DatalogFile[]): CpapFile[] {
  // Each line starts with CRLF and ends with LF, as on the card.
  const identification = encoder.encode(
    IDENTIFICATION.map(([key, value]) => `\r\n#${key} ${value}\n`).join(""),
  );

  return [
    { path: "Identification.tgt", bytes: identification },
    // Identification.crc is the CRC-32 of all of Identification.tgt.
    { path: "Identification.crc", bytes: littleEndian(crc32(identification)) },
    { path: "STR.edf", bytes: str },
    ...datalog.flatMap(({ path, bytes }): CpapFile[] => [
      { path: `${path}.edf`, bytes },
      // A night file's .crc has two CRC-32s. The first is of the 256-byte fixed header, and the
      // second is of the rest of the file.
      {
        path: `${path}.crc`,
        bytes: littleEndian(crc32(bytes.subarray(0, 256)), crc32(bytes.subarray(256))),
      },
    ]),
  ];
}

/**
 * Builds the whole CPAP data folder for `nights`, laid out as on an SD card: Identification.tgt and
 * its .crc, STR.edf, and a DATALOG folder per night that holds the night's EDF files and their
 * .crc files. `cpapData` creates a DATALOG folder only for nights that have segments.
 */
export function cpapData(
  nights: readonly SyntheticNight[],
  zone: string,
): Result<CpapFile[], SyntheticFileError> {
  return Result.combine([
    strFile(nights, zone),
    Result.combine(nights.map((night) => datalogFiles(night, zone))),
  ]).map(([str, datalog]) => folderFiles(str, datalog.flat()));
}
