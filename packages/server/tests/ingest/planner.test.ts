import { describe, expect, it } from "vitest";
import { FileKind } from "@airway/contract/derived/values";
import { readHeader } from "@airway/edf/header";
import { strFile } from "@airway/synthetic/files";
import { syntheticNights } from "@airway/synthetic/model";
import { planNights } from "../../src/ingest/planner.ts";
import type { ScannedFile } from "../../src/ingest/scan.ts";
import type { FileStates, FileVersion, ReadyFile } from "../../src/ingest/versions.ts";

// The model has three synthetic nights. STR.edf's records stop at the third night.
const model = syntheticNights({ seed: 3, nights: 3 })._unsafeUnwrap();
const [first, second, third] = model.nights.map(({ night }) => night);
const strEdf = readHeader(strFile(model.nights, model.zone)._unsafeUnwrap())._unsafeUnwrap();
const afterStr = model.nights.at(-1)?.night.add({ days: 1 });

const scanned = (path: string, night: Temporal.PlainDate | null): ScannedFile => ({
  path,
  kind: night === null ? FileKind.Str : FileKind.Brp,
  night,
  size: 100,
  ctime: Temporal.Instant.from("2030-01-08T14:00:00Z"),
});
const ready = (path: string, night: Temporal.PlainDate | null, sha256 = "a"): ReadyFile => ({
  ...scanned(path, night),
  sha256,
  edf: null,
});
const str: ReadyFile = { ...ready("STR.edf", null), edf: strEdf };
const brp = (night: Temporal.PlainDate | undefined, n = 1, sha256 = "a"): ReadyFile =>
  ready(`DATALOG/${night?.toString() ?? ""}/${n.toString()}_BRP.edf`, night ?? null, sha256);
const version = ({ path, size, sha256 }: ReadyFile): FileVersion => ({ path, size, sha256 });

const states = (overrides: Partial<FileStates>): FileStates => ({
  ready: [],
  waiting: [],
  rejected: [],
  ...overrides,
});

describe("planNights", () => {
  it("imports a new night", () => {
    const plan = planNights(states({ ready: [str, brp(first)] }), [version(str)]);

    expect(plan).toEqual({ nights: [first], waiting: [], rejected: [], rewriteStrTables: false });
  });

  it("skips a night whose files are unchanged", () => {
    const files = [str, brp(first)];

    expect(planNights(states({ ready: files }), files.map(version)).nights).toEqual([]);
  });

  it("re-plans a night when one of its files changes", () => {
    const imported = [str, brp(first, 1), brp(first, 2)].map(version);
    const plan = planNights(states({ ready: [str, brp(first, 1), brp(first, 2, "b")] }), imported);

    expect(plan.nights).toEqual([first]);
  });

  it("holds back a whole night while one of its files is waiting", () => {
    const plan = planNights(
      states({
        ready: [str, brp(first, 1), brp(second)],
        waiting: [scanned(brp(first, 2).path, first ?? null)],
      }),
      [version(str)],
    );

    expect(plan).toMatchObject({ nights: [second], waiting: [first] });
  });

  it("imports a night without its rejected file", () => {
    const truncated = {
      ...scanned(brp(first, 2).path, first ?? null),
      reason: "truncated" as const,
    };
    const plan = planNights(states({ ready: [str, brp(first, 1)], rejected: [truncated] }), [
      version(str),
    ]);

    expect(plan).toMatchObject({ nights: [first], waiting: [], rejected: [truncated] });
  });

  it("re-plans an imported night when a .crc file arrives after the import, and leaves rewriteStrTables false", () => {
    const crc: ReadyFile = { ...brp(first, 1), path: "DATALOG/x/1_BRP.crc", kind: FileKind.Crc };
    const imported = [str, brp(first, 1)].map(version);
    const plan = planNights(states({ ready: [str, brp(first, 1), crc] }), imported);

    expect(plan).toMatchObject({ nights: [first], rewriteStrTables: false });
  });

  it("re-plans an imported night when its rejected file later becomes ready", () => {
    // The first import skipped the rejected BRP file, so `imported` lists only the other two.
    const imported = [str, brp(first, 1)].map(version);
    const plan = planNights(states({ ready: [str, brp(first, 1), brp(first, 2)] }), imported);

    expect(plan.nights).toEqual([first]);
  });

  it("skips a night after one of its imported files disappears from the folder", () => {
    const imported = [str, brp(first, 1), brp(first, 2)].map(version);

    expect(planNights(states({ ready: [str, brp(first, 1)] }), imported).nights).toEqual([]);
  });

  it("holds back a night that is missing from STR.edf, and holds back every night while STR.edf is waiting", () => {
    const withStr = planNights(states({ ready: [str, brp(third), brp(afterStr)] }), [version(str)]);
    expect(withStr).toMatchObject({ nights: [third], waiting: [afterStr] });

    const waitingStr = planNights(
      states({ ready: [brp(first)], waiting: [scanned("STR.edf", null)] }),
      [version(str)],
    );
    expect(waitingStr).toMatchObject({ nights: [], waiting: [first] });
  });

  it("sets rewriteStrTables when STR.edf or Identification.tgt has a new version", () => {
    const identification: ReadyFile = {
      ...ready("Identification.tgt", null),
      kind: FileKind.Identification,
    };
    const imported = [str, identification].map(version);

    expect(planNights(states({ ready: [str, identification] }), imported).rewriteStrTables).toBe(
      false,
    );
    expect(
      planNights(states({ ready: [{ ...str, sha256: "b" }, identification] }), imported)
        .rewriteStrTables,
    ).toBe(true);
    expect(
      planNights(states({ ready: [str, { ...identification, sha256: "b" }] }), imported)
        .rewriteStrTables,
    ).toBe(true);
  });
});
