import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileChecksum } from "@airway/contract/derived/values";
import { AIRSENSE } from "@airway/edf/airsense";
import type { CpapFile } from "@airway/synthetic/cpap-data";
import { readEdfFile, readEdfHeader } from "../../src/ingest/edf.ts";
import {
  capturingLogger,
  flipByte,
  folderContext,
  syntheticFolder,
  writeFolder,
} from "../support/cpap-folder.ts";

const synthetic = (suffix: string): CpapFile => {
  const file = syntheticFolder(1).find(({ path }) => path.endsWith(suffix));

  if (file === undefined) {
    throw new Error(`expected a ${suffix} file`);
  }

  return file;
};

const missing = "DATALOG/20300101/missing_BRP.edf";

describe("readEdfHeader", () => {
  it("reads a header longer than 256 bytes and checks the size on disk", async () => {
    // A BRP header describes three signals, so it's 1,024 bytes long and `readEdfHeader` reads it
    // in two steps.
    const brp = synthetic("_BRP.edf");
    const ctx = folderContext(await writeFolder([brp]));
    const read = (await readEdfHeader(ctx, brp.path))._unsafeUnwrap();

    expect(read.header.headerBytes).toBe(1024);
    expect(read.signals.map(({ label }) => label)).toEqual(["Flow.40ms", "Press.40ms", "Crc16"]);
    expect(read.size.verdict).toBe("read");
  });

  it("returns header_too_short, with the path, for a file cut off inside its header", async () => {
    const brp = synthetic("_BRP.edf");
    const ctx = folderContext(await writeFolder([{ ...brp, bytes: brp.bytes.subarray(0, 500) }]));

    expect((await readEdfHeader(ctx, brp.path))._unsafeUnwrapErr()).toEqual({
      kind: "header_too_short",
      headerBytes: 1024,
      path: brp.path,
    });
  });

  it("returns read_failed with the relative path for a file it can't open", async () => {
    const ctx = folderContext(await writeFolder([]));

    expect((await readEdfHeader(ctx, missing))._unsafeUnwrapErr()).toMatchObject({
      kind: "read_failed",
      path: missing,
      cause: { code: "ENOENT" },
    });
  });
});

describe("readEdfFile", () => {
  it("reads a whole file's samples", async () => {
    const brp = synthetic("_BRP.edf");
    const ctx = folderContext(await writeFolder([brp]));
    const read = (await readEdfFile(ctx, brp.path, AIRSENSE.brp))._unsafeUnwrap();

    expect(read.file.records).toBeGreaterThan(0);
    expect(read.file.samples["Flow.40ms"]).toHaveLength(read.file.records * 1500);
  });

  it("returns match and 0 bad records for an intact file with a .crc", async () => {
    const brp = synthetic("_BRP.edf");
    const ctx = folderContext(await writeFolder([brp, synthetic("_BRP.crc")]));
    const { check } = (await readEdfFile(ctx, brp.path, AIRSENSE.brp))._unsafeUnwrap();

    expect(check).toEqual({ path: brp.path, checksum: FileChecksum.Match, bad_records: 0 });
  });

  it("marks a file without a .crc unchecked", async () => {
    const brp = synthetic("_BRP.edf");
    const ctx = folderContext(await writeFolder([brp]));
    const { check } = (await readEdfFile(ctx, brp.path, AIRSENSE.brp))._unsafeUnwrap();

    expect(check.checksum).toBe(FileChecksum.Unchecked);
  });

  it("reports a mismatch and a bad record after one byte of a record changes, and logs both", async () => {
    const brp = synthetic("_BRP.edf");
    // A BRP header is 1,024 bytes, so this byte is in the first record.
    const files = flipByte([brp, synthetic("_BRP.crc")], brp.path, 1024 + 5);
    const { logger, lines } = capturingLogger();
    const ctx = folderContext(await writeFolder(files), { logger });
    const { check } = (await readEdfFile(ctx, brp.path, AIRSENSE.brp))._unsafeUnwrap();

    expect(check).toEqual({ path: brp.path, checksum: FileChecksum.Mismatch, bad_records: 1 });
    expect(lines).toMatchObject([
      { level: "warn", path: brp.path, msg: "EDF file doesn't match its .crc" },
      { level: "warn", path: brp.path, badRecords: [0] },
    ]);
  });

  it("returns read_failed with the .crc's path for a .crc it can't read", async () => {
    const brp = synthetic("_BRP.edf");
    const crc = brp.path.replace(/\.edf$/v, ".crc");
    const root = await writeFolder([brp]);

    // Reading a folder fails with EISDIR.
    await mkdir(join(root, crc));

    expect(
      (await readEdfFile(folderContext(root), brp.path, AIRSENSE.brp))._unsafeUnwrapErr(),
    ).toMatchObject({ kind: "read_failed", path: crc, cause: { code: "EISDIR" } });
  });

  it("returns read_failed with the relative path for a file it can't read", async () => {
    const ctx = folderContext(await writeFolder([]));

    expect((await readEdfFile(ctx, missing, AIRSENSE.brp))._unsafeUnwrapErr()).toMatchObject({
      kind: "read_failed",
      path: missing,
      cause: { code: "ENOENT" },
    });
  });

  it("returns readEdf's error, with the path, for a file that doesn't match the file type", async () => {
    const pld = synthetic("_PLD.edf");
    const ctx = folderContext(await writeFolder([pld]));

    expect((await readEdfFile(ctx, pld.path, AIRSENSE.brp))._unsafeUnwrapErr()).toEqual({
      kind: "missing_signal",
      label: "Flow.40ms",
      path: pld.path,
    });
  });
});
