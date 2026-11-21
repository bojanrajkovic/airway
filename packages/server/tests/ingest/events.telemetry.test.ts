import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { SpanStatusCode } from "@opentelemetry/api";
import { beforeEach, describe, expect, it } from "vitest";
import { scoreNight } from "../../src/ingest/events.ts";
import {
  capturingLogger,
  caseNight,
  editEve,
  folderContext,
  writeFolder,
} from "../support/cpap-folder.ts";

const { spans } = inMemoryTelemetry();

beforeEach(() => {
  spans.reset();
});

type FinishedSpan = ReturnType<typeof spans.getFinishedSpans>[number];

const eventsSpan = (): FinishedSpan | undefined =>
  spans.getFinishedSpans().find(({ name }) => name === "ingest.events");
const encoder = new TextEncoder();

// `bytes` with every `from` replaced by `to`, which must be as long.
function replaceText(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const [find, put] = [encoder.encode(from), encoder.encode(to)];
  const copy = bytes.slice();

  for (let i = copy.indexOf(find[0] ?? 0); i !== -1; i = copy.indexOf(find[0] ?? 0, i + 1)) {
    if (find.every((byte, j) => copy[i + j] === byte)) {
      copy.set(put, i);
    }
  }

  return copy;
}

describe("scoreNight", () => {
  it("records the night, its file and event counts, and the AHI check on an ingest.events span", async () => {
    const { input, files } = caseNight("split-files");
    const scored = (
      await scoreNight(folderContext(await writeFolder(files)), input)
    )._unsafeUnwrap();

    expect(eventsSpan()?.attributes).toMatchObject({
      "airway.night": input.night.toString(),
      "airway.event_files": 3,
      "airway.events": scored.events.length,
      "airway.ahi_check": "match",
    });
  });

  it("adds one span event and one warn log per unknown label and file, with its count", async () => {
    const { logger, lines } = capturingLogger();
    const { input, files } = caseNight("ahi-rounding");
    const edited = editEve(files, (bytes) => replaceText(bytes, "Hypopnea", "Hypopnex"));

    await scoreNight(folderContext(await writeFolder(edited), { logger }), input);

    const labels = eventsSpan()?.events.filter(({ name }) => name === "ingest.unknown_event_label");

    expect(labels?.map(({ attributes }) => attributes)).toEqual([
      {
        "airway.event.label": "Hypopnex",
        "airway.file.path": input.files[0]?.path,
        "airway.event.count": 18,
      },
    ]);
    expect(lines.filter(({ msg }) => msg === "Unknown event label")).toHaveLength(1);
    expect(lines.find(({ msg }) => msg === "Unknown event label")).toMatchObject({
      level: "warn",
      module: "ingest.events",
      night: input.night.toString(),
      label: "Hypopnex",
      count: 18,
    });
  });

  it("adds a span event and a warn log with both AHIs when they disagree", async () => {
    const { logger, lines } = capturingLogger();
    const { input, files } = caseNight("ahi-rounding");
    const day = { ...input.day, signals: { ...input.day.signals, ahi: 2.8 } };

    await scoreNight(folderContext(await writeFolder(files), { logger }), { ...input, day });

    expect(eventsSpan()?.attributes["airway.ahi_check"]).toBe("mismatch");
    expect(
      eventsSpan()?.events.find(({ name }) => name === "ingest.ahi_mismatch")?.attributes,
    ).toEqual({ "airway.ahi.computed_tenths": 27, "airway.ahi.machine_tenths": 28 });
    expect(lines.find(({ msg }) => msg === "AHI mismatch")).toMatchObject({
      level: "warn",
      computed: 27,
      machine: 28,
    });
  });

  it("adds a span event and an error log when an EVE file fails to read, and fails the span", async () => {
    const { logger, lines } = capturingLogger();
    const { input, files } = caseNight("split-files");
    const ctx = folderContext(
      await writeFolder(files.filter((f) => !f.path.endsWith("_EVE.edf"))),
      {
        logger,
      },
    );

    await scoreNight(ctx, input);

    const span = eventsSpan();

    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(
      span?.events.find(({ name }) => name === "ingest.event_file_failed")?.attributes,
    ).toEqual({ "airway.file.path": input.files[0]?.path, "error.type": "read_failed" });
    expect(lines.find(({ msg }) => msg === "EVE file failed to read or parse")).toMatchObject({
      level: "error",
      error: { kind: "read_failed", path: input.files[0]?.path },
    });
  });
});
