import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { onTestFinished } from "vitest";
import { z } from "zod";
import type { DerivedRows } from "@airway/contract/derived/rows";
import type { UsedStrDay } from "@airway/contract/derived/str";
import { FileKind } from "@airway/contract/derived/values";
import { readHeader } from "@airway/edf/header";
import type { EdgeCaseName } from "@airway/synthetic/cases";
import { cpapData, type CpapFile } from "@airway/synthetic/cpap-data";
import { syntheticNights } from "@airway/synthetic/model";
import { Patient } from "@airway/synthetic/patients";
import { synthesize } from "@airway/synthetic/synthesize";
import { LogLevel } from "../../src/config.ts";
import type { EveFile, NightEvents } from "../../src/ingest/events.ts";
import { inNight, isEveFile, isSegmentFile, planTasks } from "../../src/ingest/planner.ts";
import {
  planSegments,
  type NightFiles,
  type PlannedNight,
  type SegmentFile,
} from "../../src/ingest/segments.ts";
import { readStr } from "../../src/ingest/str.ts";
import { createLogger, type Logger } from "../../src/logger.ts";
import type { AppContext } from "../../src/runtime/context.ts";
import { nightFileKind, ROOT_FILES } from "../../src/ingest/scan.ts";
import type { FileStates, RejectedFile } from "../../src/ingest/versions.ts";
import { testContext } from "./context.ts";

/**
 * Returns the files of a synthetic CPAP data folder. The folder has `nights` plain nights from seed 3,
 * followed by the `cases` edge cases.
 */
export function syntheticFolder(nights: number, cases: readonly EdgeCaseName[] = []): CpapFile[] {
  const model = syntheticNights({ seed: 3, nights, cases })._unsafeUnwrap();

  return cpapData(model.nights, model.zone)._unsafeUnwrap();
}

const CTIME = Temporal.Instant.from("2030-03-01T12:00:00Z");

// Caches each folder's file states, because every per-night helper below sorts the whole folder.
const sorted = new WeakMap<readonly CpapFile[], FileStates>();

/**
 * Sorts a synthetic folder's files as the readiness check does after every file's size stops
 * changing:
 *
 * - A file that fails the size check is rejected.
 * - Every other file is ready, with its SHA-256 and, for an EDF file, its headers.
 *
 * Like the scan, it skips SAD and CSL files and their `.crc` files.
 */
export function fileStates(files: readonly CpapFile[]): FileStates {
  const cached = sorted.get(files);

  if (cached !== undefined) {
    return cached;
  }

  const states: FileStates = { ready: [], waiting: [], rejected: [] };

  for (const { path, bytes } of files) {
    const folder = /^DATALOG\/(?<night>\d{8})\//v.exec(path)?.groups?.["night"];
    const kind = folder === undefined ? ROOT_FILES[path] : nightFileKind(path);

    if (kind === undefined) {
      continue;
    }

    const night = folder === undefined ? null : Temporal.PlainDate.from(folder);
    const scanned = { path, kind, night, size: bytes.length, ctime: CTIME };
    const isEdf = kind !== FileKind.Crc && kind !== FileKind.Identification;
    const edf = isEdf ? readHeader(bytes)._unsafeUnwrap() : null;

    if (edf?.size.verdict === "reject") {
      states.rejected.push({ ...scanned, reason: edf.size.reason });
    } else {
      states.ready.push({
        ...scanned,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        edf,
      });
    }
  }

  sorted.set(files, states);

  return states;
}

/** Returns the ready BRP and PLD files in `night`'s DATALOG folder as `SegmentFile`s. */
export const segmentFiles = (
  files: readonly CpapFile[],
  night: Temporal.PlainDate,
): SegmentFile[] => fileStates(files).ready.filter(inNight(night)).filter(isSegmentFile);

/** Returns the ready EVE files in `night`'s DATALOG folder as `EveFile`s. */
export const eveFiles = (files: readonly CpapFile[], night: Temporal.PlainDate): EveFile[] =>
  fileStates(files).ready.filter(inNight(night)).filter(isEveFile);

/** Returns the BRP, PLD, and EVE files in `night`'s DATALOG folder that fail the size check. */
export const rejectedFiles = (
  files: readonly CpapFile[],
  night: Temporal.PlainDate,
): RejectedFile[] => fileStates(files).rejected.filter(inNight(night));

/** Returns `files` after flipping the low bit of the byte at `offset` in the file at `path`. */
export const flipByte = (files: readonly CpapFile[], path: string, offset: number): CpapFile[] =>
  files.map((file) => {
    if (file.path !== path) {
      return file;
    }

    const bytes = file.bytes.slice();

    bytes[offset] = (bytes[offset] ?? 0) ^ 0x01;

    return { ...file, bytes };
  });

/** Reads the folder's STR.edf the way ingest does, and returns the days the machine was used. */
export function usedDays(files: readonly CpapFile[]): UsedStrDay[] {
  const bytes = files.find(({ path }) => path === "STR.edf")?.bytes ?? new Uint8Array();

  return readStr(bytes)
    ._unsafeUnwrap()
    .days.flatMap((day) => (day.used ? [day] : []));
}

/**
 * Describes a synthetic edge case set up for `scoreNight`. `input` is the case's first imported
 * night, `files` is its CPAP data folder, and `rows` contains the expected derived rows.
 */
export type CaseNight = { input: NightEvents; files: CpapFile[]; rows: DerivedRows };

/** Builds the `name` edge case and returns its first imported night as a `CaseNight`. */
export function caseNight(name: EdgeCaseName): CaseNight {
  const { nights, zone } = syntheticNights({ seed: 7, nights: 0, cases: [name] })._unsafeUnwrap();
  const { files, rows } = synthesize(nights, zone, {
    patient: Patient.Child,
    arrivedAt: CTIME,
  })._unsafeUnwrap();
  const day = usedDays(files).find((used) =>
    rows.nights.some(({ night: n }) => n.equals(used.day)),
  );

  if (day === undefined) {
    throw new Error("expected an imported night");
  }

  const planned = planSegments({ night: day.day, zone, day, files: segmentFiles(files, day.day) });
  const input: NightEvents = {
    night: day.day,
    zone,
    day,
    files: eveFiles(files, day.day),
    sessions: planned,
  };

  return { input, files, rows };
}

/** Returns `files` with `edit` applied to the bytes of every EVE file. */
export const editEve = (
  files: readonly CpapFile[],
  edit: (bytes: Uint8Array) => Uint8Array,
): CpapFile[] =>
  files.map((f) => (f.path.endsWith("_EVE.edf") ? { ...f, bytes: edit(f.bytes) } : f));

/**
 * Writes `files` to a new temporary folder and returns the folder's path. Vitest removes the folder
 * when the test finishes.
 */
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

/** Returns `testContext(overrides)` with `cpapDataPath` set to `root`. */
export function folderContext(root: string, overrides: Partial<AppContext> = {}): AppContext {
  const ctx = testContext(overrides);

  return { ...ctx, config: { ...ctx.config, cpapDataPath: root } };
}

/** Pairs a logger with the parsed JSON of each line it has written. */
export type CapturedLogs = { logger: Logger; lines: Record<string, unknown>[] };

const logLine = z.record(z.string(), z.unknown());

export function capturingLogger(): CapturedLogs {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(logLine.parse(JSON.parse(chunk.toString())));
      done();
    },
  });

  return { logger: createLogger(LogLevel.Info, sink), lines };
}

/** Holds a synthetic folder's planned nights, its files, and the rows that `synthesize` returns. */
export type SynthesizedNights = { planned: PlannedNight[]; files: CpapFile[]; rows: DerivedRows };

/**
 * Synthesizes `nights` plain nights from seed 7, followed by the `cases` edge cases, and plans the
 * segments of each night that `synthesize` expects ingest to import.
 */
export function synthesizedNights(cases: readonly EdgeCaseName[], nights = 0): SynthesizedNights {
  const model = syntheticNights({ seed: 7, nights, cases })._unsafeUnwrap();
  const { files, rows } = synthesize(model.nights, model.zone, {
    patient: Patient.Child,
    arrivedAt: CTIME,
  })._unsafeUnwrap();
  const planned = usedDays(files).flatMap((day): PlannedNight[] =>
    rows.nights.some(({ night }) => night.equals(day.day))
      ? [
          {
            night: day.day,
            zone: model.zone,
            segments: planSegments({
              night: day.day,
              zone: model.zone,
              day,
              files: segmentFiles(files, day.day),
            }).segments,
          },
        ]
      : [],
  );

  return { planned, files, rows };
}

/** Returns a `NightFiles` for each night that `synthesize` expects ingest to import. */
export function nightTasks({ planned, files }: SynthesizedNights): NightFiles[] {
  const [first] = planned;
  const { days } = readStr(
    files.find(({ path }) => path === "STR.edf")?.bytes ?? new Uint8Array(),
  )._unsafeUnwrap();

  return first === undefined
    ? []
    : planTasks(
        planned.map(({ night }) => night),
        fileStates(files),
        days,
        first.zone,
      ).tasks;
}
