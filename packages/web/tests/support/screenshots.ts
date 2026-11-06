import { commands, page } from "vitest/browser";

const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 800 },
  { label: "phone", width: 390, height: 844 },
] as const;
const SCHEMES = ["light", "dark"] as const;

export type ColorScheme = (typeof SCHEMES)[number];

declare module "vitest/browser" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- module augmentation merges into an interface
  interface BrowserCommands {
    /** Emulates the color scheme with Playwright's emulateMedia; vitest.config.ts defines it. */
    setColorScheme: (scheme: ColorScheme) => Promise<void>;
  }
}

/**
 * Saves `name`-<viewport>-<scheme>.png for desktop and phone, in light and dark, next to the test
 * under __screenshots__/. CI uploads them for the PR's screenshots; nothing compares them.
 */
export async function takeScreenshots(name: string): Promise<void> {
  for (const { label, width, height } of VIEWPORTS) {
    await page.viewport(width, height);

    for (const scheme of SCHEMES) {
      await commands.setColorScheme(scheme);
      await page.screenshot({ path: `__screenshots__/${name}-${label}-${scheme}.png` });
    }
  }
}
