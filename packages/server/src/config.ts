import { ClockOffsets, type ClockOffset } from "@airway/contract/clock";
import { PlainDateString } from "@airway/contract/dates";
import type { PatientProfile } from "@airway/contract/profile";
import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type Config = {
  databaseUrl: string;
  readerDatabaseUrl: string;
  patient: PatientProfile;
  clockOffsets: ClockOffset[];
  /** The IANA zone night boundaries, alert times, and every displayed time use. */
  timeZone: string;
  uiHost: string;
  mcpHost: string;
  jwksUrl: string;
  mirrorPath: string;
  port: number;
  logLevel: LogLevel;
};

export type ConfigResult = { kind: "ok"; config: Config } | { kind: "invalid"; problems: string[] };

// Intl also accepts fixed offsets such as -05:00, which have no daylight saving time, so they'd
// put night boundaries and alert times an hour off for half the year.
function isTimeZone(zone: string): boolean {
  if (/^[+\-]/v.test(zone)) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });

    return true;
  } catch {
    return false;
  }
}

const postgresUrl = z.url({ protocol: /^postgres(?:ql)?$/v, error: "must be a postgres:// URL" });
const json = z.string().transform((value, ctx): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "must be JSON" });

    return z.NEVER;
  }
});

const Env = z.object({
  DATABASE_URL: postgresUrl,
  AIRWAY_READER_DATABASE_URL: postgresUrl,
  AIRWAY_PATIENT_NAME: z.string().trim().min(1, "must not be blank").max(80),
  AIRWAY_PATIENT_BIRTH_DATE: PlainDateString,
  AIRWAY_ADULT_RULES_FROM_13: z.enum(["true", "false"]).default("false"),
  AIRWAY_CLOCK_OFFSETS: json.pipe(ClockOffsets),
  AIRWAY_TIME_ZONE: z.string().refine(isTimeZone, "must be an IANA time zone"),
  AIRWAY_UI_HOST: z.hostname({ error: "must be a hostname" }),
  AIRWAY_MCP_HOST: z.hostname({ error: "must be a hostname" }),
  AIRWAY_JWKS_URL: z.url({ protocol: /^https?$/v, error: "must be an http(s) URL" }),
  AIRWAY_MIRROR_PATH: z.string().startsWith("/", "must be an absolute path"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
});

/**
 * Parses airway's settings from `env`. A problem names its key and the rule it broke, never the
 * value, because values include passwords and the patient's birth date.
 */
export function parseConfig(env: Record<string, string | undefined>): ConfigResult {
  const result = Env.safeParse(env);

  if (!result.success) {
    return {
      kind: "invalid",
      problems: result.error.issues.map(({ path, message }) => {
        const key = String(path[0]);

        return `${key}: ${env[key] === undefined ? "is required" : message}`;
      }),
    };
  }

  const { data } = result;

  return {
    kind: "ok",
    config: {
      databaseUrl: data.DATABASE_URL,
      readerDatabaseUrl: data.AIRWAY_READER_DATABASE_URL,
      patient: {
        name: data.AIRWAY_PATIENT_NAME,
        birthDate: data.AIRWAY_PATIENT_BIRTH_DATE,
        adultRulesFrom13: data.AIRWAY_ADULT_RULES_FROM_13 === "true",
      },
      clockOffsets: data.AIRWAY_CLOCK_OFFSETS,
      timeZone: data.AIRWAY_TIME_ZONE,
      uiHost: data.AIRWAY_UI_HOST,
      mcpHost: data.AIRWAY_MCP_HOST,
      jwksUrl: data.AIRWAY_JWKS_URL,
      mirrorPath: data.AIRWAY_MIRROR_PATH,
      port: data.PORT,
      logLevel: data.LOG_LEVEL,
    },
  };
}

/** The process's settings. The only code in airway's server that reads `process.env`. */
export function loadConfig(): ConfigResult {
  return parseConfig(process.env);
}
