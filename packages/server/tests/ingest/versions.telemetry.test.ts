import { createHash } from "node:crypto";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { beforeEach, describe, expect, it } from "vitest";
import type { SeenFile } from "../../src/ingest/readiness.ts";
import { scanCpapData } from "../../src/ingest/scan.ts";
import { checkVersions, type FileStates } from "../../src/ingest/versions.ts";
import type { AppContext } from "../../src/runtime/context.ts";
import {
  capturingLogger,
  folderContext,
  syntheticFolder,
  writeFolder,
} from "../support/cpap-folder.ts";

const { spans } = inMemoryTelemetry();
const t0 = Temporal.Instant.from("2030-01-08T14:00:00Z");
const at = (minutes: number): Temporal.Instant => t0.add({ minutes });

beforeEach(() => {
  spans.reset();
});

/** One poll: scan, then sort, with this poll's read and hash span counts. */
type Poll = FileStates & { reads: number; hashes: number };

async function poll(
  ctx: AppContext,
  seen: Map<string, SeenFile>,
  now: Temporal.Instant,
): Promise<Poll> {
  spans.reset();
  const scan = (await scanCpapData(ctx))._unsafeUnwrap();
  const states = (await checkVersions(ctx, seen, scan, now))._unsafeUnwrap();
  const count = (name: string): number =>
    spans.getFinishedSpans().filter((span) => span.name === name).length;

  return { ...states, reads: count("edf.read_file"), hashes: count("ingest.hash") };
}

describe("checkVersions", () => {
  it("waits on first sight, hashes once ready, and then reopens nothing", async () => {
    const files = syntheticFolder(1);
    const ctx = folderContext(await writeFolder(files));
    const seen = new Map<string, SeenFile>();

    const first = await poll(ctx, seen, at(0));
    const kept = first.waiting.length;
    expect(first).toMatchObject({ ready: [], rejected: [], hashes: 0 });
    // Identification.tgt and .crc files aren't EDF, so only the rest have headers to read.
    expect(first.reads).toBe(
      first.waiting.filter(({ kind }) => kind !== "identification" && kind !== "crc").length,
    );

    const second = await poll(ctx, seen, at(2));
    expect(second).toMatchObject({ waiting: [], rejected: [], reads: 0, hashes: kept });
    const str = files.find(({ path }) => path === "STR.edf");
    expect(second.ready.find(({ path }) => path === "STR.edf")?.sha256).toBe(
      createHash("sha256")
        .update(str?.bytes ?? new Uint8Array())
        .digest("hex"),
    );

    const third = await poll(ctx, seen, at(7));
    expect(third).toMatchObject({ reads: 0, hashes: 0 });
    expect(third.ready).toHaveLength(kept);
  });

  it("gives a same-size rewrite a new hash after it waits 2 minutes again", async () => {
    const files = syntheticFolder(1);
    const root = await writeFolder(files);
    const ctx = folderContext(root);
    const seen = new Map<string, SeenFile>();
    await poll(ctx, seen, at(0));
    const before = (await poll(ctx, seen, at(2))).ready.find(({ path }) => path === "STR.edf");

    const str = files.find(({ path }) => path === "STR.edf")?.bytes.slice() ?? new Uint8Array();
    str[str.length - 1] = (str.at(-1) ?? 0) ^ 0xff;
    await writeFile(join(root, "STR.edf"), str);

    const changed = await poll(ctx, seen, at(10));
    expect(changed.waiting.map(({ path }) => path)).toEqual(["STR.edf"]);
    expect(changed.reads).toBe(1);

    const after = (await poll(ctx, seen, at(12))).ready.find(({ path }) => path === "STR.edf");
    expect(after?.size).toBe(before?.size);
    expect(after?.sha256).not.toBe(before?.sha256);
  });

  it("rejects damaged-files' truncated BRP and logs it once, with its counts", async () => {
    const { logger, lines } = capturingLogger();
    const ctx = folderContext(await writeFolder(syntheticFolder(0, ["damaged-files"])), { logger });
    const seen = new Map<string, SeenFile>();

    await poll(ctx, seen, at(0));
    const { rejected } = await poll(ctx, seen, at(2));
    await poll(ctx, seen, at(7));

    expect(rejected).toEqual([expect.objectContaining({ kind: "brp", reason: "truncated" })]);
    const logged = lines.filter(({ msg }) => msg === "file rejected");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      level: "warn",
      path: rejected[0]?.path,
      reason: "truncated",
    });
    expect(Number(logged[0]?.["recordsOnDisk"])).toBeLessThan(
      Number(logged[0]?.["declaredRecords"]),
    );
  });

  it("reads a header again after an I/O failure, and logs each failure", async () => {
    const { logger, lines } = capturingLogger();
    const root = await writeFolder(syntheticFolder(1));
    const ctx = folderContext(root, { logger });
    const seen = new Map<string, SeenFile>();
    await chmod(join(root, "STR.edf"), 0o000);

    await poll(ctx, seen, at(0));
    const failing = await poll(ctx, seen, at(2));
    await chmod(join(root, "STR.edf"), 0o644);
    // chmod changes the ctime, so the recovered file waits 2 minutes before it's ready.
    await poll(ctx, seen, at(7));
    const recovered = await poll(ctx, seen, at(9));

    expect(failing.rejected.map(({ path }) => path)).toEqual(["STR.edf"]);
    expect(recovered.ready.map(({ path }) => path)).toContain("STR.edf");
    expect(recovered.rejected).toEqual([]);
    expect(lines.filter(({ msg }) => msg === "header not read; retrying next poll")).toHaveLength(
      2,
    );
  });

  it("forgets a path that leaves the folder", async () => {
    const files = syntheticFolder(1);
    const root = await writeFolder(files);
    const ctx = folderContext(root);
    const seen = new Map<string, SeenFile>();
    await poll(ctx, seen, at(0));

    await rm(join(root, "Identification.tgt"));
    await poll(ctx, seen, at(2));

    expect(seen.has("Identification.tgt")).toBe(false);
  });
});
