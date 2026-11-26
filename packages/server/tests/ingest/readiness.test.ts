import { describe, expect, it } from "vitest";
import { readHeader } from "@airway/edf/header";
import { EdgeCaseName } from "@airway/synthetic/cases";
import {
  checkReadiness,
  type HeaderRead,
  type Readiness,
  type SeenFile,
} from "../../src/ingest/readiness.ts";
import { syntheticFolder } from "../support/cpap-folder.ts";

const t0 = Temporal.Instant.from("2030-01-08T14:00:00Z");
const at = (minutes: number): Temporal.Instant => t0.add({ seconds: minutes * 60 });

// The damaged-files case has two BRP files. The undamaged one comes first, then the truncated one.
const brps = syntheticFolder(0, [EdgeCaseName.DamagedFiles]).filter(({ path }) =>
  path.endsWith("_BRP.edf"),
);
const headerOf = (bytes: Uint8Array): HeaderRead => ({
  kind: "read",
  file: readHeader(bytes)._unsafeUnwrap(),
});
const truncated = brps.find(
  ({ bytes }) => readHeader(bytes)._unsafeUnwrap().size.verdict === "reject",
);
const whole = brps[0];

const seen = (overrides: Partial<SeenFile> = {}): SeenFile => ({
  size: 1000,
  ctime: t0,
  since: t0,
  header: whole === undefined ? { kind: "not_edf" } : headerOf(whole.bytes),
  sha256: null,
  rejectionLogged: false,
  ...overrides,
});

describe("checkReadiness", () => {
  const resized = seen({ size: 2000, since: at(10) });
  const unparsed = seen({
    header: { kind: "failed", error: { kind: "header_too_short", headerBytes: 256 } },
  });

  const tooSoon: Readiness = { state: "waiting", reason: "too_soon" };
  const ready: Readiness = { state: "ready" };

  it.each<{
    name: string;
    previous: SeenFile | undefined;
    current: SeenFile;
    now: Temporal.Instant;
    expected: Readiness;
  }>([
    { name: "first sight", previous: undefined, current: seen(), now: at(0), expected: tooSoon },
    {
      name: "the same size under 2 minutes",
      previous: seen(),
      current: seen(),
      now: at(1.9),
      expected: tooSoon,
    },
    {
      name: "the same size at 2 minutes",
      previous: seen(),
      current: seen(),
      now: at(2),
      expected: ready,
    },
    {
      name: "the same size well past 2 minutes",
      previous: seen(),
      current: seen(),
      now: at(60),
      expected: ready,
    },
    {
      name: "a size change, which restarts the clock",
      previous: seen(),
      current: resized,
      now: at(10),
      expected: { state: "waiting", reason: "size_changed" },
    },
    {
      name: "a changed size held for 2 minutes",
      previous: resized,
      current: resized,
      now: at(12),
      expected: ready,
    },
    {
      name: "a header that can't be parsed",
      previous: seen(),
      current: unparsed,
      now: at(5),
      expected: { state: "rejected", reason: "unreadable" },
    },
    {
      name: "a file that isn't EDF",
      previous: seen(),
      current: seen({ header: { kind: "not_edf" } }),
      now: at(5),
      expected: ready,
    },
  ])("$name", ({ previous, current, now, expected }) => {
    expect(checkReadiness(previous, current, now)).toEqual(expected);
  });

  it("makes damaged-files' truncated BRP wait on first sight, then rejects it on every poll", () => {
    expect(truncated).toBeDefined();
    const file = seen({ header: headerOf(truncated?.bytes ?? new Uint8Array()) });

    expect(checkReadiness(undefined, file, at(0))).toEqual({
      state: "waiting",
      reason: "too_soon",
    });
    for (const minutes of [2, 7, 12]) {
      expect(checkReadiness(file, file, at(minutes))).toEqual({
        state: "rejected",
        reason: "truncated",
      });
    }
  });
});
