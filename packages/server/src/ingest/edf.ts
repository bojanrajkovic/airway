import { join } from "node:path";
import type { ResultAsync } from "neverthrow";
import { readFileHeader } from "@airway/edf/file-header";
import type { EdfFile, EdfReadError } from "@airway/edf/header";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";

/**
 * Reads the header of the EDF file at `path`, relative to the CPAP data folder, and checks its
 * size, inside an `edf.read_file` span. Each header warning is logged at `warn`. The span records
 * the format, the size verdict, the whole records on disk, and the warning kinds.
 */
export function readEdfFile(ctx: AppContext, path: string): ResultAsync<EdfFile, EdfReadError> {
  const logger = ctx.logger.child({ module: "ingest.edf", path });

  return inSpanAsync("edf.read_file", (span) => {
    span.setAttribute("airway.file.path", path);

    return readFileHeader(join(ctx.config.cpapDataPath, path)).map((file) => {
      span.setAttributes({
        "edf.format": file.header.format,
        "edf.verdict": file.size.verdict,
        "edf.warnings": file.warnings.map((warning) => warning.kind),
      });
      if (file.size.verdict !== "reject") {
        span.setAttributes({
          "edf.records": file.size.records,
          "edf.header_count": file.size.header,
        });
      }

      for (const warning of file.warnings) {
        logger.warn({ warning }, "EDF header warning");
      }

      return file;
    });
  });
}
