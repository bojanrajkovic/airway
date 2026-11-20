import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { onTestFinished } from "vitest";
import { z } from "zod";
import type { EdgeCaseName } from "@airway/synthetic/cases";
import { cpapData, type CpapFile } from "@airway/synthetic/cpap-data";
import { syntheticNights } from "@airway/synthetic/model";
import { createLogger, type Logger } from "../../src/logger.ts";
import type { AppContext } from "../../src/runtime/context.ts";
import { testContext } from "./context.ts";

/** A synthetic CPAP data folder's files: `nights` plain nights from seed 3, then `cases`. */
export function syntheticFolder(nights: number, cases: readonly EdgeCaseName[] = []): CpapFile[] {
  const model = syntheticNights({ seed: 3, nights, cases })._unsafeUnwrap();

  return cpapData(model.nights, model.zone)._unsafeUnwrap();
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
