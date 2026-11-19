import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { beforeEach, describe, expect, it } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { Result } from "neverthrow";
import { readHeader, type EdfFile, type EdfReadError } from "@airway/edf/header";
import type { CpapFile } from "@airway/synthetic/cpap-data";
import { readEdfFile } from "../../src/ingest/edf.ts";
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

type Read = {
  result: Result<EdfFile, EdfReadError>;
  span: ReadableSpan | undefined;
  lines: Record<string, unknown>[];
};

async function read(file: CpapFile): Promise<Read> {
  const { logger, lines } = capturingLogger();
  const ctx = folderContext(await writeFolder([file]), { logger });
  const result = await readEdfFile(ctx, file.path);
  const [span] = spans.getFinishedSpans().filter(({ name }) => name === "edf.read_file");

  return { result, span, lines };
}

const brp = (): CpapFile => {
  const file = syntheticFolder(1).find(({ path }) => path.endsWith("_BRP.edf"));

  if (file === undefined) {
    throw new Error("expected a BRP file");
  }

  return file;
};

describe("readEdfFile", () => {
  it("records the file's path, format, verdict, and records on its span", async () => {
    const file = brp();
    const { result, span } = await read(file);

    const records = result._unsafeUnwrap().size;
    expect(records.verdict).toBe("read");
    expect(span?.attributes).toEqual({
      "airway.file.path": file.path,
      "edf.format": "EDF",
      "edf.verdict": "read",
      "edf.records": records.verdict === "read" ? records.records : -1,
      "edf.header_count": "matches",
      "edf.warning_count": 0,
    });
  });

  it("records a rejected file's verdict without a record count", async () => {
    const file = brp();
    const { span } = await read({
      ...file,
      bytes: file.bytes.subarray(0, file.bytes.length - 100),
    });

    expect(span?.attributes["edf.verdict"]).toBe("reject");
    expect(span?.attributes).not.toHaveProperty("edf.records");
  });

  it("logs each header warning with the file's path", async () => {
    const file = brp();
    const bytes = file.bytes.slice();
    // The recording field starts at byte 88; change its Startdate's day so it disagrees.
    const recording = new TextDecoder().decode(bytes.subarray(88, 168));
    const changed = recording.replace(
      /Startdate (\d{2})/v,
      (_, day: string) => `Startdate ${day === "01" ? "02" : "01"}`,
    );
    bytes.set(new TextEncoder().encode(changed), 88);

    const { span, lines } = await read({ ...file, bytes });

    const [warning] = readHeader(bytes)._unsafeUnwrap().warnings;
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
    const ctx = testContext();
    const result = await readEdfFile(ctx, "DATALOG/20300101/missing_BRP.edf");
    const [span] = spans.getFinishedSpans();

    expect(result._unsafeUnwrapErr().kind).toBe("read_failed");
    expect(span?.attributes["error.type"]).toBe("read_failed");
  });
});
