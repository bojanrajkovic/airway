// Records ingest's metrics on the main thread, from each night's result. A counter recorded in a
// worker would split into one series per thread and reset when the worker restarts.
import { metrics, type Counter, type Histogram } from "@opentelemetry/api";
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

  /** Records how long a database write took, by kind and outcome. */
  wrote(write: WriteKind, outcome: Outcome, seconds: number): void {
    this.#writeDuration.record(seconds, { "airway.ingest.write": write, outcome });
  }

  /** Records how long one recompute of the period percentiles took, by outcome. */
  recomputedPercentiles(outcome: Outcome, seconds: number): void {
    this.#percentilesDuration.record(seconds, { outcome });
  }
}
