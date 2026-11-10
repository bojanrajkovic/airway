import type { Author } from "@airway/contract/author";
import { ClockOffsets, type ClockOffset } from "@airway/contract/clock";
import { PlainDateString } from "@airway/contract/dates";
import type { PatientProfile } from "@airway/contract/profile";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * How requests are authenticated. `pomerium` verifies the identity proxy's signed token; `none`
 * treats every request as the configured local person.
 */
export type AuthConfig =
  | {
      mode: "pomerium";
      /** The UI's public hostname: the `aud` and `iss` of tokens on /trpc. */
      uiHost: string;
      /** The MCP route's public hostname: the `aud` and `iss` of tokens on /mcp. */
      mcpHost: string;
      jwksUrl: string;
    }
  | { mode: "none"; author: Pick<Author, "name" | "email"> };

export type Config = {
  databaseUrl: string;
  readerDatabaseUrl: string;
  patient: PatientProfile;
  clockOffsets: ClockOffset[];
  /** The IANA zone night boundaries, alert times, and every displayed time use. */
  timeZone: string;
  cpapDataPath: string;
  port: number;
  logLevel: LogLevel;
  auth: AuthConfig;
};

// The places Intl knows, by their ICU names. Fixed offsets such as -05:00, UTC, and Etc/GMT+5 aren't
// listed; they have no daylight saving time, so they'd put night boundaries an hour off for half
// the year.
const PLACES = new Set(Intl.supportedValuesOf("timeZone"));

// A place's zone name, such as America/Chicago. Intl resolves aliases and current names to the ICU
// name first, so Asia/Kolkata and US/Eastern pass.
function isTimeZone(zone: string): boolean {
  try {
    return PLACES.has(
      new Intl.DateTimeFormat(undefined, { timeZone: zone }).resolvedOptions().timeZone,
    );
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
  AIRWAY_CPAP_DATA_PATH: z.string().startsWith("/", "must be an absolute path"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
});

// Required with no default, so a deployment that forgets it stops instead of running open.
const Auth = z.discriminatedUnion(
  "AIRWAY_AUTH",
  [
    z.object({
      AIRWAY_AUTH: z.literal("pomerium"),
      AIRWAY_UI_HOST: z.hostname("must be a bare hostname"),
      AIRWAY_MCP_HOST: z.hostname("must be a bare hostname"),
      AIRWAY_JWKS_URL: z.url({ protocol: /^https?$/v, error: "must be an http(s):// URL" }),
    }),
    z.object({
      AIRWAY_AUTH: z.literal("none"),
      AIRWAY_LOCAL_AUTHOR_NAME: z.string().trim().min(1, "must not be blank").max(80),
      AIRWAY_LOCAL_AUTHOR_EMAIL: z.email("must be an email address"),
    }),
  ],
  { error: "must be pomerium or none" },
);

/** Parses airway's settings from `env`. Each problem names its key and what's wrong with it. */
export function parseConfig(env: Record<string, string | undefined>): Result<Config, string[]> {
  const result = z.intersection(Env, Auth).safeParse(env);

  if (!result.success) {
    return err(
      result.error.issues.map(({ path, message }) => {
        const key = String(path[0]);

        return `${key}: ${env[key] === undefined ? "is required" : message}`;
      }),
    );
  }

  const { data } = result;

  return ok({
    databaseUrl: data.DATABASE_URL,
    readerDatabaseUrl: data.AIRWAY_READER_DATABASE_URL,
    patient: {
      name: data.AIRWAY_PATIENT_NAME,
      birthDate: data.AIRWAY_PATIENT_BIRTH_DATE,
      adultRulesFrom13: data.AIRWAY_ADULT_RULES_FROM_13 === "true",
    },
    clockOffsets: data.AIRWAY_CLOCK_OFFSETS,
    timeZone: data.AIRWAY_TIME_ZONE,
    cpapDataPath: data.AIRWAY_CPAP_DATA_PATH,
    port: data.PORT,
    logLevel: data.LOG_LEVEL,
    auth:
      data.AIRWAY_AUTH === "pomerium"
        ? {
            mode: "pomerium",
            uiHost: data.AIRWAY_UI_HOST,
            mcpHost: data.AIRWAY_MCP_HOST,
            jwksUrl: data.AIRWAY_JWKS_URL,
          }
        : {
            mode: "none",
            author: { name: data.AIRWAY_LOCAL_AUTHOR_NAME, email: data.AIRWAY_LOCAL_AUTHOR_EMAIL },
          },
  });
}

/** The process's settings. The only code in airway's server that reads `process.env`. */
export function loadConfig(): Result<Config, string[]> {
  return parseConfig(process.env);
}
