import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { onTestFinished } from "vitest";
import { z } from "zod";
import { readHeader } from "@airway/edf/header";
import type { EdgeCaseName } from "@airway/synthetic/cases";
import { cpapData, type CpapFile } from "@airway/synthetic/cpap-data";
import { syntheticNights } from "@airway/synthetic/model";
import type { SegmentFile } from "../../src/ingest/segments.ts";
import { createLogger, type Logger } from "../../src/logger.ts";
import type { AppContext } from "../../src/runtime/context.ts";
import { testContext } from "./context.ts";

/** A synthetic CPAP data folder's files: `nights` plain nights from seed 3, then `cases`. */
export function syntheticFolder(nights: number, cases: readonly EdgeCaseName[] = []): CpapFile[] {
  const model = syntheticNights({ seed: 3, nights, cases })._unsafeUnwrap();

  return cpapData(model.nights, model.zone)._unsafeUnwrap();
}

const CTIME = Temporal.Instant.from("2030-03-01T12:00:00Z");

/**
 * The BRP and PLD files of `night`'s folder in `files`, as the readiness check passes them on: with
 * their headers read, and without the files it rejects.
 */
export function segmentFiles(files: readonly CpapFile[], night: Temporal.PlainDate): SegmentFile[] {
  const folder = `DATALOG/${night.toString().replaceAll("-", "")}/`;

  return files.flatMap(({ path, bytes }): SegmentFile[] => {
    const kind = path.endsWith("_BRP.edf") ? "brp" : path.endsWith("_PLD.edf") ? "pld" : undefined;

    if (kind === undefined || !path.startsWith(folder)) {
      return [];
    }

    const edf = readHeader(bytes)._unsafeUnwrap();
    const { size } = edf;

    return size.verdict === "reject"
      ? []
      : [
          {
            path,
            kind,
            night,
            size: bytes.length,
            ctime: CTIME,
            sha256: "",
            edf: { ...edf, size },
          },
        ];
  });
}

/** Writes `files` under a new temporary folder, removed when the test finishes, and returns it. */
export async function writeFolder(files: readonly CpapFile[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "airway-cpap-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const { path, bytes } of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }

  return root;
}

/** `testContext(overrides)` with its CPAP data folder at `root`. */
export function folderContext(root: string, overrides: Partial<AppContext> = {}): AppContext {
  const ctx = testContext(overrides);

  return { ...ctx, config: { ...ctx.config, cpapDataPath: root } };
}

/** A logger, and each line it has written, parsed. */
export type CapturedLogs = { logger: Logger; lines: Record<string, unknown>[] };

const logLine = z.record(z.string(), z.unknown());

/** A logger that keeps each line it writes. */
export function capturingLogger(): CapturedLogs {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(logLine.parse(JSON.parse(chunk.toString())));
      done();
    },
  });

  return { logger: createLogger("info", sink), lines };
}
