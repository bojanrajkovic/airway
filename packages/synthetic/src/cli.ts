// pnpm synth: writes a synthetic CPAP data folder that `pnpm dev` can import.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ClockOffsets } from "@airway/contract/clock";
import { cpapData } from "./cpap-data.ts";
import { syntheticNights } from "./model.ts";
import { PATIENTS, type Patient } from "./patients.ts";

const USAGE = "Usage: pnpm synth --out <dir> [--seed 1] [--nights 10] [--patient child|adult]";
// .env.example's AIRWAY_CLOCK_OFFSETS, so the folder imports with the example config.
const OFFSETS = ClockOffsets.parse([{ from: "2025-01-01", utcOffset: "-05:00" }]);

function fail(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

const wholeNumber = (flag: string, text: string, min: number): number => {
  const value = Number(text);

  return Number.isInteger(value) && value >= min
    ? value
    : fail(`--${flag} must be a whole number of at least ${min.toString()}.`);
};

const isPatient = (text: string): text is Patient => PATIENTS.some((patient) => patient === text);

// Treats a missing folder as empty.
async function isEmpty(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }

    throw error;
  }
}

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    seed: { type: "string", default: "1" },
    nights: { type: "string", default: "10" },
    patient: { type: "string", default: "child" },
  },
});

const out = values.out ?? fail("--out is required.");
const patient = isPatient(values.patient)
  ? values.patient
  : fail("--patient must be child or adult.");
const nights = syntheticNights({
  seed: wholeNumber("seed", values.seed, 0),
  nights: wholeNumber("nights", values.nights, 1),
  patient,
});
const dir = resolve(out);

if (!(await isEmpty(dir))) {
  fail(`${dir} isn't empty. Pick a new folder, so synthetic files never mix with real ones.`);
}

const files = cpapData(nights, OFFSETS);

if (files.isErr()) {
  fail(`Couldn't write the folder: ${files.error.kind}.`);
}

for (const { path, bytes } of files.value) {
  const target = join(dir, path);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

process.stdout.write(`Wrote ${nights.length.toString()} ${patient} nights to ${dir}\n`);
