import { crc32 } from "node:zlib";
import { Result } from "neverthrow";
import type { ClockOffset } from "@airway/contract/clock";
import { DEVICE, nightFiles, strFile, type NightFile, type SyntheticFileError } from "./files.ts";
import type { SyntheticNight } from "./model.ts";

/** One file in the CPAP data folder: its path from the folder's root, and its bytes. */
export type CpapFile = { path: string; bytes: Uint8Array };

// Identification.tgt's keys in the card's order. Ingest reads #SRN and #PNA; the other values are
// placeholders.
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

// 20300107_213412_BRP.edf, from the file's start on the device clock.
const fileName = ({ kind, start }: NightFile): string =>
  `${compact(start.toPlainDate())}_${start.toPlainTime().toString().replaceAll(":", "").slice(0, 6)}_${kind.toUpperCase()}`;

/** A night's EDF file with its path in the folder, without the extension. */
export type DatalogFile = NightFile & { path: string };

/** A night's EDF files with their DATALOG paths, in `nightFiles`'s order. */
export function datalogFiles(
  night: SyntheticNight,
  offsets: readonly ClockOffset[],
): Result<DatalogFile[], SyntheticFileError> {
  return nightFiles(night, offsets).map((files) =>
    files.map((file) => ({ ...file, path: `DATALOG/${compact(night.night)}/${fileName(file)}` })),
  );
}

/** The top-level and per-night files of the folder, with a .crc beside each night file. */
export function folderFiles(str: Uint8Array, datalog: readonly DatalogFile[]): CpapFile[] {
  // Each line starts with CRLF and ends with LF, as on the card.
  const identification = encoder.encode(
    IDENTIFICATION.map(([key, value]) => `\r\n#${key} ${value}\n`).join(""),
  );

  return [
    { path: "Identification.tgt", bytes: identification },
    // The top-level .crc covers the whole companion file.
    { path: "Identification.crc", bytes: littleEndian(crc32(identification)) },
    { path: "STR.edf", bytes: str },
    ...datalog.flatMap(({ path, bytes }): CpapFile[] => [
      { path: `${path}.edf`, bytes },
      // A night file's .crc covers its 256-byte fixed header, then the rest.
      {
        path: `${path}.crc`,
        bytes: littleEndian(crc32(bytes.subarray(0, 256)), crc32(bytes.subarray(256))),
      },
    ]),
  ];
}

/**
 * The whole CPAP data folder for `nights`, as an SD card lays it out: Identification.tgt and its
 * .crc, STR.edf, and a DATALOG folder per night holding each EDF file and its .crc. A night with no
 * segments writes no files, so it has no folder.
 */
export function cpapData(
  nights: readonly SyntheticNight[],
  offsets: readonly ClockOffset[],
): Result<CpapFile[], SyntheticFileError> {
  return Result.combine([
    strFile(nights, offsets),
    Result.combine(nights.map((night) => datalogFiles(night, offsets))),
  ]).map(([str, datalog]) => folderFiles(str, datalog.flat()));
}
