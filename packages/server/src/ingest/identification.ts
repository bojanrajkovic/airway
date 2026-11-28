// Reads the device's serial and model from Identification.tgt.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import type { DeviceRow } from "@airway/contract/derived/rows";
import { FileChecksum } from "@airway/contract/derived/values";
import { checkCompanion } from "@airway/edf/checksum";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";
import { isNotFound, readFailed, type ReadFailed } from "./read-failed.ts";

/** Reports an Identification.tgt that has no `#SRN` or no `#PNA` line. */
export type IdentificationError = { kind: "missing_key"; key: "SRN" | "PNA" };

/** Reports an Identification.tgt that can't be read or parsed. `path` is the file that failed. */
export type ReadIdentificationError = (IdentificationError & { path: string }) | ReadFailed;

/** Pairs the device row with the result of checking Identification.tgt against its `.crc`. */
export type Identification = { device: DeviceRow; check: FileChecksum };

/**
 * Parses Identification.tgt's `#KEY value` lines and returns the serial from `#SRN` and the model
 * from `#PNA`. Lines that don't start with `#` are ignored. Returns `missing_key` with the first
 * key that's absent.
 */
export function parseIdentification(bytes: Uint8Array): Result<DeviceRow, IdentificationError> {
  const values = new Map(
    new TextDecoder()
      .decode(bytes)
      .split(/\r?\n/v)
      .flatMap((line): [string, string][] => {
        const match = /^#(?<key>\w+) (?<value>.*)$/v.exec(line.trim());

        return match?.groups === undefined
          ? []
          : [[match.groups["key"] ?? "", match.groups["value"] ?? ""]];
      }),
  );
  const serial = values.get("SRN");
  const model = values.get("PNA");

  return serial === undefined || model === undefined
    ? err({ kind: "missing_key", key: serial === undefined ? "SRN" : "PNA" })
    : ok({ serial, model });
}

const readFrom = (
  ctx: Pick<AppContext, "config">,
  path: string,
): ResultAsync<Uint8Array, ReadIdentificationError> =>
  ResultAsync.fromPromise(readFile(join(ctx.config.cpapDataPath, path)), readFailed(path));

/**
 * Reads Identification.tgt and Identification.crc from the CPAP data folder in an
 * `ingest.identification` span, and returns the device row and the checksum result. The checksum
 * is `unchecked` when the `.crc` is missing. The span records the model and the checksum.
 */
export function readIdentification(
  ctx: Pick<AppContext, "config">,
): ResultAsync<Identification, ReadIdentificationError> {
  return inSpanAsync("ingest.identification", (span) =>
    readFrom(ctx, "Identification.tgt")
      .andThen((tgt) =>
        parseIdentification(tgt)
          .mapErr((error) => ({ ...error, path: "Identification.tgt" }))
          .asyncAndThen((device) =>
            readFrom(ctx, "Identification.crc")
              .map((crc): FileChecksum => checkCompanion(tgt, crc))
              .orElse((error) =>
                error.kind === "read_failed" && isNotFound(error.cause)
                  ? okAsync(FileChecksum.Unchecked)
                  : errAsync(error),
              )
              .map((check) => ({ device, check })),
          ),
      )
      .map((identification) => {
        span.setAttributes({
          "airway.device.model": identification.device.model,
          "airway.file.checksum": identification.check,
        });

        return identification;
      }),
  );
}
