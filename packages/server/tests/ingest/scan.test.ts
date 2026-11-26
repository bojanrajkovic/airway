import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileKind } from "@airway/contract/derived/values";
import { scanCpapData, type Scan } from "../../src/ingest/scan.ts";
import { folderContext, syntheticFolder, writeFolder } from "../support/cpap-folder.ts";

const byText = (a: string, b: string): number => a.localeCompare(b);

async function scan(root: string): Promise<Scan> {
  return (await scanCpapData(folderContext(root)))._unsafeUnwrap();
}

describe("scanCpapData", () => {
  it("lists the root files and each night's BRP, PLD, and EVE files with their .crc, and counts the rest", async () => {
    const files = syntheticFolder(2);
    const { files: scanned, skipped } = await scan(await writeFolder(files));

    const kept = files.filter(({ path }) =>
      /(STR\.edf|Identification\.(tgt|crc)|_(BRP|PLD|EVE)\.(edf|crc))$/v.test(path),
    );
    expect(scanned.map(({ path }) => path).toSorted(byText)).toEqual(
      kept.map(({ path }) => path).toSorted(byText),
    );
    expect(scanned.filter(({ kind }) => kind === FileKind.Crc)).not.toHaveLength(0);
    expect(skipped).toEqual({
      sad: files.filter(({ path }) => path.endsWith("_SAD.edf")).length,
      csl: files.filter(({ path }) => path.endsWith("_CSL.edf")).length,
      crc: files.filter(({ path }) => /_(SAD|CSL)\.crc$/v.test(path)).length,
      other: 0,
      folder: 0,
    });
  });

  it("gives each file its kind, its folder's night, and its size", async () => {
    const files = syntheticFolder(1);
    const { files: scanned } = await scan(await writeFolder(files));
    const brp = files.find(({ path }) => path.endsWith("_BRP.edf"));
    const folder = brp?.path.split("/")[1] ?? "";

    expect(scanned.find(({ path }) => path === brp?.path)).toMatchObject({
      kind: "brp",
      night: Temporal.PlainDate.from(folder),
      size: brp?.bytes.length,
    });
    expect(scanned.find(({ path }) => path === "STR.edf")).toMatchObject({
      kind: "str",
      night: null,
    });
    expect(scanned.find(({ path }) => path === "Identification.tgt")).toMatchObject({
      kind: "identification",
      night: null,
    });
  });

  it("skips folders that aren't dates and entries it doesn't read", async () => {
    const root = await writeFolder(syntheticFolder(1));
    const night =
      (await scan(root)).files.find(({ night }) => night !== null)?.path.split("/")[1] ?? "";
    await mkdir(join(root, "DATALOG", "20301399"));
    await mkdir(join(root, "DATALOG", "notes"));
    await writeFile(join(root, "DATALOG", "20301104"), "a file, not a folder");
    await mkdir(join(root, "DATALOG", night, "nested"));
    await writeFile(join(root, "DATALOG", night, "readme.txt"), "");
    await mkdir(join(root, "SETTINGS"));

    const { skipped } = await scan(root);

    expect(skipped.folder).toBe(3);
    expect(skipped.other).toBe(3);
  });

  it("finds no nights when the DATALOG folder doesn't exist", async () => {
    const root = await writeFolder(
      syntheticFolder(1).filter(({ path }) => !path.startsWith("DATALOG/")),
    );

    expect((await scan(root)).files.map(({ path }) => path).toSorted(byText)).toEqual([
      "Identification.crc",
      "Identification.tgt",
      "STR.edf",
    ]);
  });

  it("fails when the CPAP data folder can't be read", async () => {
    const result = await scanCpapData(folderContext("/nonexistent/cpap-data"));

    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "read_failed",
      path: "/nonexistent/cpap-data",
      cause: { code: "ENOENT" },
    });
  });
});
