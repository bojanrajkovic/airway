import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { App } from "../src/App.tsx";
import { expectNoAxeViolations } from "./support/axe.ts";
import { takeScreenshots } from "./support/screenshots.ts";

it("renders the shell with no accessibility violations", async () => {
  const screen = await render(<App />);

  await expect.element(screen.getByRole("heading", { level: 1, name: "airway" })).toBeVisible();
  await expectNoAxeViolations(screen.container);
  await takeScreenshots("shell");
});
