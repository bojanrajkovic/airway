// pnpm synth: writes a synthetic CPAP data folder that `pnpm dev` can import.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EDGE_CASE_NAMES, type EdgeCaseName } from "./cases.ts";
import { cpapData } from "./cpap-data.ts";
import { syntheticNights } from "./model.ts";
import { PATIENTS, type Patient } from "./patients.ts";

const USAGE =
  "Usage: pnpm synth --out <dir> [--seed 1] [--nights 10] [--patient child|adult]\n" +
  "  [--cases all|none|<name>,<name>...] [--time-zone America/Chicago]";

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

const isCase = (text: string): text is EdgeCaseName =>
  EDGE_CASE_NAMES.some((name) => name === text);

function cases(text: string): "all" | EdgeCaseName[] {
  if (text === "all" || text === "none") {
    return text === "all" ? "all" : [];
  }

  const names = text.split(",");
  const unknown = names.filter((name) => !isCase(name));

  return unknown.length === 0
    ? names.filter(isCase)
    : fail(`Unknown --cases: ${unknown.join(", ")}. Known: ${EDGE_CASE_NAMES.join(", ")}.`);
}

function timeZone(text: string): string {
  try {
    return Temporal.Now.zonedDateTimeISO(text).timeZoneId;
  } catch {
    return fail(`--time-zone ${text} isn't a time zone Temporal knows.`);
  }
}

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
    cases: { type: "string", default: "all" },
    "time-zone": { type: "string", default: "America/Chicago" },
  },
});

const out = values.out ?? fail("--out is required.");
const patient = isPatient(values.patient)
  ? values.patient
  : fail("--patient must be child or adult.");
const model = syntheticNights({
  seed: wholeNumber("seed", values.seed, 0),
  nights: wholeNumber("nights", values.nights, 1),
  patient,
  cases: cases(values.cases),
  zone: timeZone(values["time-zone"]),
});

if (model.isErr()) {
  fail(
    `Couldn't build the ${model.error.name} nights in ${model.error.zone}: it has no such transition.`,
  );
}

const { nights, zone } = model.value;
const dir = resolve(out);

if (!(await isEmpty(dir))) {
  fail(`${dir} isn't empty. Pick a new folder, so synthetic files never mix with real ones.`);
}

const files = cpapData(nights, zone);

if (files.isErr()) {
  fail(`Couldn't write the folder: ${files.error.kind}.`);
}

for (const { path, bytes } of files.value) {
  const target = join(dir, path);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

// The server reads the device clock with this zone's winter offset.
process.stdout.write(
  `Wrote ${nights.length.toString()} ${patient} nights to ${dir}\n` + `AIRWAY_TIME_ZONE=${zone}\n`,
);
