import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { App } from "../src/App.tsx";
import { takeScreenshots } from "./support/screenshots.ts";

it("renders the shell", async () => {
  const screen = await render(<App />);

  await expect.element(screen.getByRole("heading", { level: 1, name: "airway" })).toBeVisible();
  await takeScreenshots("shell");
});
