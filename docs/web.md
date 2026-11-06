# Web

`packages/web` is a React 19 app built with Vite. `pnpm dev` serves it with hot reload and forwards `/healthz`, `/trpc`, and `/mcp` to the server. `pnpm build` writes it to `packages/server/dist/public/`, where the server serves it.

## Startup

`src/main.ts` loads `temporal-polyfill` only in browsers without a native `Temporal`, then imports `src/start.tsx`, which renders the app. The app loads after the polyfill, so a module that uses `Temporal` when it loads works in every browser.

The page follows the device's light or dark setting: `index.html` declares `color-scheme: light dark`, and so does `src/styles/base.css`, which the app imports.

## The React Compiler

The build runs the React Compiler through Babel. It adds `useMemo` and `useCallback` where they help, so components don't need them by hand. Code has to follow the [Rules of React](https://react.dev/reference/rules), which lint checks.

## Lint

`oxlint.web.ts` turns on every rule in Oxlint's `react` and `jsx-a11y` plugins for `packages/web`, as errors, including the React Compiler rules, which Oxlint turns off by default. A few rules are off on purpose, each with its reason in that file: every `react-perf` rule, because the React Compiler memoizes what they flag, plus `react/react-in-jsx-scope`, `react/jsx-no-literals`, `react/forbid-component-props`, `react/jsx-max-depth`, and `react/jsx-props-no-spreading`.

## Content-Security-Policy

The server sends one policy, from `@airway/contract/csp`: everything loads from airway itself, with no inline scripts or styles, no plugins, and no framing. Vite's dev server sends none, because hot reload needs inline scripts.

Design tokens, components, routes, and time display aren't built yet.
