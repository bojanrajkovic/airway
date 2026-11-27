import { describe, expect, it } from "vitest";
import { FileChecksum } from "@airway/contract/derived/values";
import { DEVICE } from "@airway/synthetic/files";
import { parseIdentification, readIdentification } from "../../src/ingest/identification.ts";
import { folderContext, syntheticFolder, writeFolder } from "../support/cpap-folder.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("parseIdentification", () => {
  it("reads the serial and model from CRLF lines and ignores other keys", () => {
    const text = "#IMF 0001\r\n#SRN 12345678901\r\n#SID SX000-0000\r\n#PNA AirSense_10_AutoSet\r\n";

    expect(parseIdentification(bytes(text))._unsafeUnwrap()).toEqual({
      serial: "12345678901",
      model: "AirSense_10_AutoSet",
    });
  });

  it("returns missing_key when #SRN is absent", () => {
    expect(parseIdentification(bytes("#PNA AirSense_10_AutoSet\n"))._unsafeUnwrapErr()).toEqual({
      kind: "missing_key",
      key: "SRN",
    });
  });
});

describe("readIdentification", () => {
  it("checks Identification.tgt against Identification.crc", async () => {
    const root = await writeFolder(syntheticFolder(1));

    expect((await readIdentification(folderContext(root)))._unsafeUnwrap()).toEqual({
      device: { serial: DEVICE.serial, model: DEVICE.model },
      check: FileChecksum.Match,
    });
  });

  it("returns unchecked when Identification.crc is missing", async () => {
    const files = syntheticFolder(1).filter(({ path }) => path !== "Identification.crc");
    const root = await writeFolder(files);

    expect((await readIdentification(folderContext(root)))._unsafeUnwrap().check).toBe(
      FileChecksum.Unchecked,
    );
  });
});
