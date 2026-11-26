import type { Author } from "@airway/contract/author";
import { PlainDateString } from "@airway/contract/dates";
import type { PatientProfile } from "@airway/contract/profile";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

export enum LogLevel {
  Fatal = "fatal",
  Error = "error",
  Warn = "warn",
  Info = "info",
  Debug = "debug",
  Trace = "trace",
}

/**
 * The server authenticates requests in one of two modes. In `pomerium` mode, it verifies the token
 * that the identity proxy signed. In `none` mode, it treats every request as coming from the
 * configured local person.
 */
export type AuthConfig =
  | {
      mode: "pomerium";
      /** The `aud` and `iss` claims of tokens on /trpc must equal the UI's public hostname. */
      uiHost: string;
      /**
       * The `aud` and `iss` claims of tokens on /mcp must equal the MCP route's public hostname.
       */
      mcpHost: string;
      jwksUrl: string;
    }
  | { mode: "none"; author: Pick<Author, "name" | "email"> };

export type Config = {
  databaseUrl: string;
  readerDatabaseUrl: string;
  patient: PatientProfile;
  /** `timeZone` is the home IANA time zone. docs/configuration.md describes its uses. */
  timeZone: string;
  cpapDataPath: string;
  /** After this home time of day, a used night whose folder is absent counts as missing. */
  dataMissingCutoff: Temporal.PlainTime;
  port: number;
  logLevel: LogLevel;
  auth: AuthConfig;
};

// Contains the ICU names of the place zones that Intl supports. Intl's list excludes fixed offsets
// such as -05:00, UTC, and Etc/GMT+5. A fixed offset never shifts for daylight saving time, so it
// would put night boundaries an hour off for half the year.
const PLACES = new Set(Intl.supportedValuesOf("timeZone"));

// Returns whether `zone` is a place's zone name, such as America/Chicago. Intl resolves an alias or
// a current name to its ICU name before the lookup, so Asia/Kolkata and US/Eastern pass.
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

const Env = z.object({
  DATABASE_URL: postgresUrl,
  AIRWAY_READER_DATABASE_URL: postgresUrl,
  AIRWAY_PATIENT_NAME: z.string().trim().min(1, "must not be blank").max(80),
  AIRWAY_PATIENT_BIRTH_DATE: PlainDateString,
  AIRWAY_ADULT_RULES_FROM_13: z.enum(["true", "false"]).default("false"),
  AIRWAY_TIME_ZONE: z.string().refine(isTimeZone, "must be an IANA time zone"),
  AIRWAY_CPAP_DATA_PATH: z.string().startsWith("/", "must be an absolute path"),
  AIRWAY_DATA_MISSING_CUTOFF: z.iso
    .time({ precision: -1, error: "must be a time like 15:00" })
    .default("15:00")
    .transform((time) => Temporal.PlainTime.from(time)),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(LogLevel).default(LogLevel.Info),
});

// Every deployment must set `AIRWAY_AUTH`. A deployment that leaves it unset stops instead of
// serving requests without authentication.
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

/** Parses airway's settings from `env`. Each error names a key and says what's wrong with it. */
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
    timeZone: data.AIRWAY_TIME_ZONE,
    cpapDataPath: data.AIRWAY_CPAP_DATA_PATH,
    dataMissingCutoff: data.AIRWAY_DATA_MISSING_CUTOFF,
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

export function loadConfig(): Result<Config, string[]> {
  return parseConfig(process.env);
}
