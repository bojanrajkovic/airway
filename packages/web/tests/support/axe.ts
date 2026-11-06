import axe from "axe-core";
import { expect } from "vitest";

/** Runs axe-core on `root` and fails with each violated rule and how many elements break it. */
export async function expectNoAxeViolations(root: Element): Promise<void> {
  const { violations } = await axe.run(root);

  expect(violations.map(({ id, nodes }) => `${id}: ${String(nodes.length)} element(s)`)).toEqual(
    [],
  );
}
