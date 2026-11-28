// `IngestMetrics` records each night's result, and `ImportMetrics` records each import pass and its
// database writes.
import { metrics, type Counter, type Gauge, type Histogram } from "@opentelemetry/api";
import type { ResultAsync } from "neverthrow";
import { FileChecksum } from "@airway/contract/derived/values";
import { valuesOf } from "@airway/contract/enum";
import { NightStep, type NightResult } from "./night.ts";
import type { NightPoolError } from "./pool.ts";
import type { NightFiles } from "./segments.ts";
import type { ReadyFile } from "./versions.ts";

const NIGHT_STEPS = valuesOf(NightStep);

/** Names the data that a database write stores, as the value of the `airway.ingest.write` attribute. */
export enum WriteKind {
  Night = "night",
  Str = "str",
}

/** Names how a timed step ended. */
export type Outcome = "ok" | "error";

// Returns every BRP, PLD, and EVE file in a night's files. Each file includes the `kind` that the scan set.
const filesOf = ({ files, eveFiles }: NightFiles): ReadyFile[] => [...files, ...eveFiles];

/**
 * Creates ingest's counters and histograms. `createNightPool` constructs one after the SDK starts,
 * because a meter created before the SDK starts stays a no-op.
 */
export class IngestMetrics {
  readonly #meter = metrics.getMeter("airway/ingest");
  readonly #rows: Counter = this.#meter.createCounter("airway.ingest.rows", {
    description: "Rows that ingest computed, by table.",
    unit: "{row}",
  });
  readonly #filesRead: Counter = this.#meter.createCounter("airway.ingest.files_read", {
    description: "BRP, PLD, and EVE files that ingest read, by kind and outcome.",
    unit: "{file}",
  });
  readonly #nightDuration: Histogram = this.#meter.createHistogram("airway.ingest.night.duration", {
    description: "Time from asking the pool for a night to its result, by outcome.",
    unit: "s",
  });
  readonly #stepDuration: Histogram = this.#meter.createHistogram("airway.ingest.step.duration", {
    description: "Time each step of a night's computation took, by step.",
    unit: "s",
  });
  readonly #queueDuration: Histogram = this.#meter.createHistogram("airway.ingest.queue.duration", {
    description: "Time a night waited for a free worker.",
    unit: "s",
  });

  /** Records a night that `run` computed in `seconds`. */
  succeeded(task: NightFiles, night: NightResult, seconds: number): void {
    const rows = {
      segments: night.segments.segments.length,
      sessions: night.segments.sessions.length,
      events: night.scored.events.length,
      samples: night.samples.reduce((sum, { ts }) => sum + ts.length, 0),
      breaths: night.breaths.reduce((sum, { ts }) => sum + ts.length, 0),
    };

    for (const [table, count] of Object.entries(rows)) {
      this.#rows.add(count, { "airway.table": table });
    }

    const checksums = new Map(night.checks.map(({ path, checksum }) => [path, checksum]));

    for (const { kind, path } of filesOf(task)) {
      this.#filesRead.add(1, {
        "airway.file.kind": kind,
        "airway.file.checksum": checksums.get(path) ?? FileChecksum.Unchecked,
        outcome: "ok",
      });
    }

    for (const step of NIGHT_STEPS) {
      this.#stepDuration.record(night.steps[step], { "airway.ingest.step": step });
    }

    const computing = NIGHT_STEPS.reduce((sum, step) => sum + night.steps[step], 0);
    this.#queueDuration.record(Math.max(0, seconds - computing));
    this.#nightDuration.record(seconds, { outcome: "ok" });
  }

  /**
   * Records a night that failed after `seconds`. If a file read failed, it also counts one read
   * error for that file's kind.
   */
  failed(task: NightFiles, error: NightPoolError, seconds: number): void {
    const failedFile =
      error.kind === "worker_failed"
        ? undefined
        : filesOf(task).find(({ path }) => path === error.path);

    if (failedFile !== undefined) {
      this.#filesRead.add(1, { "airway.file.kind": failedFile.kind, outcome: "error" });
    }

    this.#nightDuration.record(seconds, { outcome: "error" });
  }
}

/**
 * Runs `step` and passes its outcome and duration in seconds to `record`. Returns `step`'s result.
 */
export function timed<T, E>(
  record: (outcome: Outcome, seconds: number) => void,
  step: () => ResultAsync<T, E>,
): ResultAsync<T, E> {
  const start = performance.now();
  const seconds = (): number => (performance.now() - start) / 1000;

  return step()
    .andTee(() => {
      record("ok", seconds());
    })
    .orTee(() => {
      record("error", seconds());
    });
}

/**
 * Creates the instruments that record each import pass, its database writes, and its percentile
 * recomputes. A meter that `getMeter` returns before the OpenTelemetry SDK starts is a no-op.
 */
export class ImportMetrics {
  readonly #meter = metrics.getMeter("airway/ingest");
  readonly #importDuration: Histogram = this.#meter.createHistogram(
    "airway.ingest.import.duration",
    { description: "Time one import pass took, by outcome.", unit: "s" },
  );
  readonly #nightsUnused: Gauge = this.#meter.createGauge("airway.ingest.nights_unused", {
    description: "Nights in the last import pass that STR.edf marks unused.",
    unit: "{night}",
  });
  readonly #writeDuration: Histogram = this.#meter.createHistogram("airway.ingest.write.duration", {
    description: "Time one database write took, by kind and outcome.",
    unit: "s",
  });
  readonly #percentilesDuration: Histogram = this.#meter.createHistogram(
    "airway.ingest.percentiles.duration",
    {
      description: "Time one recompute of the period percentiles took, by outcome.",
      unit: "s",
    },
  );

  /** Records how long one import pass took, by outcome. */
  imported(outcome: Outcome, seconds: number): void {
    this.#importDuration.record(seconds, { outcome });
  }

  /** Records how many nights the last import pass found unused. */
  nightsUnused(count: number): void {
    this.#nightsUnused.record(count);
  }

  /** Records how long a database write took, by kind and outcome. */
  wrote(write: WriteKind, outcome: Outcome, seconds: number): void {
    this.#writeDuration.record(seconds, { "airway.ingest.write": write, outcome });
  }

  /** Records how long one recompute of the period percentiles took, by outcome. */
  recomputedPercentiles(outcome: Outcome, seconds: number): void {
    this.#percentilesDuration.record(seconds, { outcome });
  }
}
