import { join } from "node:path";
import type { Attributes } from "@opentelemetry/api";
import type { ResultAsync } from "neverthrow";
import { readFileHeader } from "@airway/edf/file-header";
import type { EdfFile, EdfReadError, EdfWarning } from "@airway/edf/header";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";

/** A header warning's kind and details, for its span event. A new kind won't compile here. */
function warningAttributes({ kind, headerDate, startdate }: EdfWarning): Attributes {
  return {
    "edf.warning.kind": kind,
    "edf.warning.header_date": headerDate.toString(),
    "edf.warning.startdate": startdate.toString(),
  };
}

/**
 * Reads the header of the EDF file at `path`, relative to the CPAP data folder, and checks its
 * size, inside an `edf.read_file` span. The span records the format, the size verdict, the whole
 * records on disk, and the warning count. Each header warning becomes an `edf.warning` span event
 * with its kind and details, and is logged at `warn`.
 */
export function readEdfFile(ctx: AppContext, path: string): ResultAsync<EdfFile, EdfReadError> {
  const logger = ctx.logger.child({ module: "ingest.edf", path });

  return inSpanAsync("edf.read_file", (span) => {
    span.setAttribute("airway.file.path", path);

    return readFileHeader(join(ctx.config.cpapDataPath, path)).map((file) => {
      span.setAttributes({
        "edf.format": file.header.format,
        "edf.verdict": file.size.verdict,
        "edf.warning_count": file.warnings.length,
      });
      if (file.size.verdict !== "reject") {
        span.setAttributes({
          "edf.records": file.size.records,
          "edf.header_count": file.size.header,
        });
      }

      for (const warning of file.warnings) {
        span.addEvent("edf.warning", warningAttributes(warning));
        logger.warn({ warning }, "EDF header warning");
      }

      return file;
    });
  });
}
