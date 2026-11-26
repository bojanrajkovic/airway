import { err } from "neverthrow";
import { describe, expect, it } from "vitest";
import { valuesOf } from "@airway/contract/enum";
import { transformer } from "@airway/contract/transformer";
import { EdgeCaseName } from "@airway/synthetic/cases";
import {
  computeNight,
  decodeNight,
  decodeTask,
  encodeNight,
  encodeTask,
  NightStep,
  type NightResult,
} from "../../src/ingest/night.ts";
import {
  folderContext,
  nightTasks,
  synthesizedNights,
  writeFolder,
} from "../support/cpap-folder.ts";
import { toSampleRows } from "../support/rows.ts";

describe("computeNight", () => {
  it("returns each night's sessions, events, samples, and breaths", async () => {
    const synthetic = synthesizedNights([EdgeCaseName.SplitFiles], 2);
    const { rows } = synthetic;
    const ctx = folderContext(await writeFolder(synthetic.files));
    const tasks = nightTasks(synthetic);

    expect(tasks.length).toBeGreaterThan(0);

    for (const task of tasks) {
      const result = (await computeNight(ctx, task))._unsafeUnwrap();
      const ofNight = <T extends { night: Temporal.PlainDate }>(list: readonly T[]): T[] =>
        list.filter(({ night }) => night.equals(task.night));

      expect(result.segments.sessions).toHaveLength(ofNight(rows.sessions).length);
      expect(result.scored.events).toHaveLength(ofNight(rows.events).length);
      expect(toSampleRows(task.night, result.samples)).toEqual(ofNight(rows.samples));
      expect(result.breaths.reduce((sum, { ts }) => sum + ts.length, 0)).toBe(
        ofNight(rows.breaths).length,
      );
      expect(Object.keys(result.steps)).toEqual(valuesOf(NightStep));
      expect(Object.values(result.steps).every((seconds) => seconds >= 0)).toBe(true);
    }
  });

  it("returns a read_failed error with the path of a missing EVE file", async () => {
    const synthetic = synthesizedNights([], 1);
    const [task] = nightTasks(synthetic);
    const eve = task?.eveFiles[0]?.path;

    if (task === undefined || eve === undefined) {
      throw new Error("expected a night with an EVE file");
    }

    const ctx = folderContext(
      await writeFolder(synthetic.files.filter(({ path }) => path !== eve)),
    );

    expect((await computeNight(ctx, task))._unsafeUnwrapErr()).toMatchObject({
      kind: "read_failed",
      path: eve,
    });
  });
});

describe("encodeNight", () => {
  // Serializes a result to text through superjson, because toEqual treats any two Temporal
  // values of the same type as equal.
  const asText = ({ samples, breaths, ...rest }: NightResult): string =>
    JSON.stringify([transformer.serialize(rest), samples, breaths], (_, value: unknown) =>
      value instanceof Float64Array ? Array.from(value) : value,
    );

  it("round-trips a result through structured cloning with its buffers transferred, Temporal values included", async () => {
    const synthetic = synthesizedNights([], 1);
    const [task] = nightTasks(synthetic);

    if (task === undefined) {
      throw new Error("expected a night");
    }

    const result = await computeNight(folderContext(await writeFolder(synthetic.files)), task);
    const expected = asText(result._unsafeUnwrap());
    const { wire, transfer } = encodeNight(result);

    expect(transfer.length).toBeGreaterThan(0);

    const back = decodeNight(structuredClone(wire, { transfer }))._unsafeUnwrap();

    expect(back.night).toBeInstanceOf(Temporal.PlainDate);
    expect(back.scored.events[0]?.ts).toBeInstanceOf(Temporal.Instant);
    expect(asText(back)).toBe(expected);
  });

  it("round-trips an error with its cause's message and stack", () => {
    const cause = new Error("ENOENT: no such file or directory");
    const error = { kind: "read_failed", path: "DATALOG/20300101/a_EVE.edf", cause } as const;
    const { wire, transfer } = encodeNight(err(error));

    const back = decodeNight(structuredClone(wire, { transfer }))._unsafeUnwrapErr();

    expect(back).toMatchObject({ kind: "read_failed", path: error.path });
    expect(back.kind === "read_failed" && back.cause).toMatchObject({
      message: cause.message,
      stack: cause.stack,
    });
  });
});

describe("encodeTask", () => {
  it("round-trips a task through structured cloning, Temporal values included", () => {
    const [task] = nightTasks(synthesizedNights([], 1));

    if (task === undefined) {
      throw new Error("expected a night");
    }

    const back = decodeTask(structuredClone(encodeTask(task)));

    expect(back.night.equals(task.night)).toBe(true);
    expect(back.files[0]?.edf.header.start).toBeInstanceOf(Temporal.PlainDateTime);
    expect(back.files[0]?.ctime.equals(task.files[0]?.ctime ?? "")).toBe(true);
    expect(transformer.stringify(back)).toBe(transformer.stringify(task));
  });
});
