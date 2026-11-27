import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { beforeEach, describe, expect, it } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { AIRSENSE } from "@airway/edf/airsense";
import { readHeader } from "@airway/edf/header";
import type { CpapFile } from "@airway/synthetic/cpap-data";
import { readEdfFile, readEdfHeader } from "../../src/ingest/edf.ts";
import {
  capturingLogger,
  folderContext,
  syntheticFolder,
  writeFolder,
} from "../support/cpap-folder.ts";
import { testContext } from "../support/context.ts";

const { spans } = inMemoryTelemetry();

beforeEach(() => {
  spans.reset();
});

const spanNamed = (name: string): ReadableSpan | undefined =>
  spans.getFinishedSpans().find((span) => span.name === name);

const brp = (): CpapFile => {
  const file = syntheticFolder(1).find(({ path }) => path.endsWith("_BRP.edf"));

  if (file === undefined) {
    throw new Error("expected a BRP file");
  }

  return file;
};

// Returns `file` with the recording field's Startdate moved to another day, so `readHeader`
// reports a `startdate_mismatch`.
function withStartdateMismatch(file: CpapFile): CpapFile {
  const bytes = file.bytes.slice();
  // The recording field starts at byte 88.
  const recording = new TextDecoder().decode(bytes.subarray(88, 168));
  const changed = recording.replace(
    /Startdate (\d{2})/v,
    (_, day: string) => `Startdate ${day === "01" ? "02" : "01"}`,
  );
  bytes.set(new TextEncoder().encode(changed), 88);

  return { ...file, bytes };
}

describe("readEdfHeader", () => {
  it("sets the path, format, verdict, and record count on the edf.read_header span", async () => {
    const file = brp();
    const ctx = folderContext(await writeFolder([file]));
    const { size } = (await readEdfHeader(ctx, file.path))._unsafeUnwrap();

    expect(size.verdict).toBe("read");
    expect(spanNamed("edf.read_header")?.attributes).toEqual({
      "airway.file.path": file.path,
      "edf.format": "EDF",
      "edf.verdict": "read",
      "edf.records": size.verdict === "read" ? size.records : -1,
      "edf.header_count": "matches",
      "edf.warning_count": 0,
    });
  });

  it("records a rejected file's verdict without a record count", async () => {
    const file = brp();
    const cut = { ...file, bytes: file.bytes.subarray(0, file.bytes.length - 100) };
    await readEdfHeader(folderContext(await writeFolder([cut])), file.path);

    const span = spanNamed("edf.read_header");
    expect(span?.attributes["edf.verdict"]).toBe("reject");
    expect(span?.attributes).not.toHaveProperty("edf.records");
  });

  it("logs each header warning with the file's path", async () => {
    const file = withStartdateMismatch(brp());
    const { logger, lines } = capturingLogger();
    await readEdfHeader(folderContext(await writeFolder([file]), { logger }), file.path);

    const [warning] = readHeader(file.bytes)._unsafeUnwrap().warnings;
    const span = spanNamed("edf.read_header");
    expect(span?.attributes["edf.warning_count"]).toBe(1);
    expect(span?.events.map(({ name, attributes }) => ({ name, attributes }))).toEqual([
      {
        name: "edf.warning",
        attributes: {
          "edf.warning.kind": "startdate_mismatch",
          "edf.warning.header_date": warning?.headerDate.toString(),
          "edf.warning.startdate": warning?.startdate.toString(),
        },
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "warn",
      module: "ingest.edf",
      path: file.path,
      warning: { kind: "startdate_mismatch" },
    });
  });

  it("marks the span failed when the file can't be read", async () => {
    await readEdfHeader(testContext(), "DATALOG/20300101/missing_BRP.edf");

    expect(spanNamed("edf.read_header")?.attributes["error.type"]).toBe("read_failed");
  });
});

describe("readEdfFile", () => {
  it("sets the path, format, record count, and checksum results on the edf.read_file span", async () => {
    const file = brp();
    const ctx = folderContext(await writeFolder([file]));
    const read = (await readEdfFile(ctx, file.path, AIRSENSE.brp))._unsafeUnwrap();

    expect(spanNamed("edf.read_file")?.attributes).toEqual({
      "airway.file.path": file.path,
      "edf.format": "EDF",
      "edf.records": read.file.records,
      "edf.warning_count": 0,
      "edf.checksum": "unchecked",
      "edf.bad_records": 0,
    });
  });

  it("counts header warnings without logging them again", async () => {
    const file = withStartdateMismatch(brp());
    const { logger, lines } = capturingLogger();
    await readEdfFile(
      folderContext(await writeFolder([file]), { logger }),
      file.path,
      AIRSENSE.brp,
    );

    expect(spanNamed("edf.read_file")?.attributes["edf.warning_count"]).toBe(1);
    expect(lines).toEqual([]);
  });

  it("marks the span failed with the error's kind", async () => {
    await readEdfFile(testContext(), "DATALOG/20300101/missing_BRP.edf", AIRSENSE.brp);

    expect(spanNamed("edf.read_file")?.attributes["error.type"]).toBe("read_failed");
  });
});
