import type {
  ProcedureInputs,
  ProcedureName,
  ProcedureOutputs,
  PROCEDURES,
} from "@airway/contract/api/procedures";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { expectTypeOf, test } from "vitest";
import type { AppRouter } from "../../src/trpc/router.ts";

// `tsc --project tests` fails when one of these type-level checks is false.

/** Resolves to the value at a dotted path such as `notes.add`, or to `never` for a missing path. */
type At<Tree, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof Tree
    ? At<Tree[Head], Rest>
    : never
  : Path extends keyof Tree
    ? Tree[Path]
    : never;

// Resolves to `true` when the two types are exactly equal. Checking `extends` both ways would
// also accept types that differ by `any` or by an optional field.
type Same<One, Other> =
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- this exact-equality check needs the otherwise unused parameter
  (<T>() => T extends One ? 1 : 2) extends <T>() => T extends Other ? 1 : 2 ? true : false;

type Inputs = inferRouterInputs<AppRouter>;
type Outputs = inferRouterOutputs<AppRouter>;
type Procedure<Name extends string> = At<AppRouter["_def"]["record"], Name>;

/** Lists the catalog procedures that the router doesn't serve. */
type Unserved = {
  [Name in ProcedureName]: [Procedure<Name>] extends [never] ? Name : never;
}[ProcedureName];

/** Lists the served procedures whose kind, input, or output differs from the catalog. */
type Mismatched = {
  [Name in Exclude<ProcedureName, Unserved>]: Same<
    [Procedure<Name>["_def"]["type"], At<Inputs, Name>, At<Outputs, Name>],
    [(typeof PROCEDURES)[Name]["kind"], ProcedureInputs[Name], ProcedureOutputs[Name]]
  > extends true
    ? never
    : Name;
}[Exclude<ProcedureName, Unserved>];

/** Remove a procedure from this list when the router starts serving it. */
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
