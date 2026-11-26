import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "rolldown";
import { describe, expect, it, onTestFinished } from "vitest";
import { bundle } from "../../rolldown.config.ts";
import { createNightPool, type NightPool } from "../../src/ingest/pool.ts";
import {
  folderContext,
  nightTasks,
  synthesizedNights,
  writeFolder,
} from "../support/cpap-folder.ts";
import { testContext } from "../support/context.ts";

// The tests write workers under the package directory, so a bundled worker resolves its
// dependencies from the package's node_modules.
const WORKERS = join(import.meta.dirname, "../../.test-workers");

async function workerDir(): Promise<string> {
  await mkdir(WORKERS, { recursive: true });
  const dir = await mkdtemp(join(WORKERS, "pool-"));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  return dir;
}

// Writes a worker module with `source` as its body and returns its path.
async function worker(source: string): Promise<string> {
  const path = join(await workerDir(), "worker.mjs");
  await writeFile(path, source);

  return path;
}

// Starts a pool on `filename` and closes it when the test finishes.
function pool(filename: string, ctx = testContext()): NightPool {
  const started = createNightPool(ctx, { filename });
  onTestFinished(async () => {
    await started[Symbol.asyncDispose]();
  });

  return started;
}

const [task] = nightTasks(synthesizedNights([], 1));

if (task === undefined) {
  throw new Error("expected a synthetic night");
}

// Returns "ready" for the warm-up, and returns a read_failed error for a night, with the night's
// date as the error's path.
const ECHO = `
export default async function (message) {
  if (message.kind === "warm_up") return "ready";
  return { ok: false, error: { kind: "read_failed", path: message.task.json.night, cause: null } };
}
`;

describe("createNightPool", () => {
  it('sets ready after a worker returns "ready" for the warm-up', async () => {
    const nights = pool(await worker(ECHO));

    expect(nights.ready).toBe(false);
    await nights.warmUp();
    expect(nights.ready).toBe(true);
  });

  it("leaves ready false when the worker can't load", async () => {
    const nights = pool(await worker(`throw new Error("can't load");`));

    await nights.warmUp();

    expect(nights.ready).toBe(false);
  });

  it("sends the task to a worker and decodes its result", async () => {
    const nights = pool(await worker(ECHO));

    expect((await nights.run(task))._unsafeUnwrapErr()).toEqual({
      kind: "read_failed",
      path: task.night.toString(),
      cause: null,
    });
  });

  it("returns worker_failed when the worker throws", async () => {
    const nights = pool(
      await worker(`export default async function () { throw new Error("crashed"); }`),
    );

    expect((await nights.run(task))._unsafeUnwrapErr()).toMatchObject({ kind: "worker_failed" });
  });

  it("keeps an idle worker's event loop running between tasks", async () => {
    // A blocking wait between tasks would freeze the worker's timers, including the timer that
    // exports telemetry.
    const nights = pool(
      await worker(`
let ticks = 0;
setInterval(() => { ticks += 1; }, 10);
export default async function () {
  return { ok: false, error: { kind: "read_failed", path: String(ticks), cause: null } };
}
`),
    );
    const ticks = async (): Promise<number> => {
      const error = (await nights.run(task))._unsafeUnwrapErr();

      return error.kind === "worker_failed" ? Number.NaN : Number(error.path);
    };

    const before = await ticks();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect((await ticks()) - before).toBeGreaterThan(5);
  });

  it("computes a synthetic night in the bundled worker", async () => {
    const dir = await workerDir();
    await build(bundle("night-worker", "src/ingest/night-worker.ts", dir));
    const synthetic = synthesizedNights([], 1);
    const [night] = nightTasks(synthetic);

    if (night === undefined) {
      throw new Error("expected a synthetic night");
    }

    const ctx = folderContext(await writeFolder(synthetic.files));
    const nights = pool(join(dir, "night-worker.js"), ctx);
    await nights.warmUp();
    const result = (await nights.run(night))._unsafeUnwrap();

    expect(nights.ready).toBe(true);
    expect(result.night.equals(night.night)).toBe(true);
    expect(result.scored.events).toHaveLength(
      synthetic.rows.events.filter((row) => row.night.equals(night.night)).length,
    );
    expect(result.samples.reduce((sum, { ts }) => sum + ts.length, 0)).toBe(
      synthetic.rows.samples.filter((row) => row.night.equals(night.night)).length,
    );
  }, 60_000);
});
