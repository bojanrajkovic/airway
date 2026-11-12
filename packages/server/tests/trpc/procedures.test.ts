import type {
  ProcedureInputs,
  ProcedureName,
  ProcedureOutputs,
  PROCEDURES,
} from "@airway/contract/api/procedures";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { expectTypeOf, test } from "vitest";
import type { AppRouter } from "../../src/trpc/router.ts";

// These checks are type-level: `tsc --project tests` fails if one doesn't hold.

/** The value at a dotted path such as `notes.add`, or never when the path doesn't exist. */
type At<Tree, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof Tree
    ? At<Tree[Head], Rest>
    : never
  : Path extends keyof Tree
    ? Tree[Path]
    : never;

// Exact type equality. Checking `extends` both ways would treat `any` and optional fields as equal.
type Same<One, Other> =
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- this exact-equality check needs the otherwise unused parameter
  (<T>() => T extends One ? 1 : 2) extends <T>() => T extends Other ? 1 : 2 ? true : false;

type Inputs = inferRouterInputs<AppRouter>;
type Outputs = inferRouterOutputs<AppRouter>;
type Procedure<Name extends string> = At<AppRouter["_def"]["record"], Name>;

/** Catalog entries the router doesn't serve yet. */
type Unserved = {
  [Name in ProcedureName]: [Procedure<Name>] extends [never] ? Name : never;
}[ProcedureName];

/** Served procedures whose kind, input, or output differs from the catalog's. */
type Mismatched = {
  [Name in Exclude<ProcedureName, Unserved>]: Same<
    [Procedure<Name>["_def"]["type"], At<Inputs, Name>, At<Outputs, Name>],
    [(typeof PROCEDURES)[Name]["kind"], ProcedureInputs[Name], ProcedureOutputs[Name]]
  > extends true
    ? never
    : Name;
}[Exclude<ProcedureName, Unserved>];

/**
 * The procedures no PR has served yet. A PR that adds one to the router removes it here, and the
 * check below then holds it to the catalog's shape. The list empties as the API is built.
 */
type NotYetServed =
  | "query.run"
  | "query.tile"
  | "query.rows"
  | "sql.run"
  | "links.resolve"
  | "history.list"
  | "notes.list"
  | "notes.get"
  | "notes.add"
  | "notes.update"
  | "notes.delete"
  | "notes.restore"
  | "findings.get"
  | "findings.runNow"
  | "summary.lastNight"
  | "summary.range"
  | "summary.settingsChanges"
  | "waveform.window"
  | "waveform.night"
  | "app.status";

test("the router serves the catalog's procedures in the catalog's shapes", () => {
  expectTypeOf<Unserved>().toEqualTypeOf<NotYetServed>();
  expectTypeOf<Mismatched>().toEqualTypeOf<never>();
});
