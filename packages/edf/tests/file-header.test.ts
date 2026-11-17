import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileHeader } from "../src/file-header.ts";
import { crc16, file, flow, plain } from "./bytes.ts";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "airway-edf-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true });
});

async function saved(name: string, bytes: Uint8Array): Promise<string> {
  const path = join(dir, name);

  await writeFile(path, bytes);

  return path;
}

describe("readFileHeader", () => {
  it("reads a header longer than 256 bytes and checks the size on disk", async () => {
    // Ten signals make a 2,816-byte header, so it takes a second read.
    const signals = [
      ...Array.from({ length: 9 }, (_, i) => ({ ...flow, label: `S${i.toString()}` })),
      crc16,
    ];
    const record = 2 * (9 * 2 + 1);
    const path = await saved("long.edf", file(plain({ records: "2", signals }), 3 * record));
    const parsed = (await readFileHeader(path))._unsafeUnwrap();

    expect(parsed.header.headerBytes).toBe(2816);
    expect(parsed.header.signals).toHaveLength(10);
    expect(parsed.size).toEqual({ verdict: "read", header: "undercounted", records: 3 });
  });

  it("reports a file cut off inside its header", async () => {
    const path = await saved("cut.edf", file(plain(), 0).subarray(0, 500));

    expect((await readFileHeader(path))._unsafeUnwrapErr()).toEqual({
      kind: "header_too_short",
      headerBytes: 768,
    });
  });

  it("reports a file it can't open", async () => {
    const path = join(dir, "missing.edf");

    expect((await readFileHeader(path))._unsafeUnwrapErr()).toMatchObject({
      kind: "read_failed",
      path,
    });
  });
});
