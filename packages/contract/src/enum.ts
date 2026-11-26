/**
 * Returns the values of a string enum as a non-empty tuple, in declaration order. `z.enum`, the
 * registry's enum columns, and the CHECK constraints in `ddl.ts` each require a non-empty tuple.
 */
export const valuesOf = <E extends string>(members: Readonly<Record<string, E>>): [E, ...E[]] =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every enum passed here has at least one member, which TypeScript can't express
  Object.values(members) as [E, ...E[]];
