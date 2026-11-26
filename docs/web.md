# Web

`packages/web` is a React 19 app built with Vite. `pnpm dev` serves it with hot reload and forwards `/healthz`, `/trpc`, and `/mcp` to the server. `pnpm build` writes it to `packages/server/dist/public/`, where the server serves it.

## Startup

`src/main.ts` loads `temporal-polyfill` only in browsers without a native `Temporal`, then imports `src/start.tsx`, which renders the app. The polyfill loads before the app, so a module that uses `Temporal` at import time works in every browser.

The page follows the device's light or dark setting, because `index.html` and `src/styles/base.css` both declare `color-scheme: light dark`. The app imports `base.css`.

## The React Compiler

The build runs the React Compiler through Babel. The compiler adds `useMemo` and `useCallback` where they help, so we don't write them by hand. Code has to follow the [Rules of React](https://react.dev/reference/rules), and lint reports code that breaks them.

## Lint

`oxlint.web.ts` turns on every rule in Oxlint's `react` and `jsx-a11y` plugins for `packages/web`, and reports each as an error. That includes the React Compiler rules, which Oxlint turns off by default. The file turns a few rules off and gives the reason for each. It turns off every `react-perf` rule, because the React Compiler memoizes what those rules flag. It also turns off `react/react-in-jsx-scope`, `react/jsx-no-literals`, `react/forbid-component-props`, `react/jsx-max-depth`, and `react/jsx-props-no-spreading`.

## Content-Security-Policy

The server sends one policy, which comes from `@airway/contract/csp`. The policy lets the page load resources only from airway itself, and it blocks inline scripts, inline styles, plugins, and framing. Vite's dev server leaves the policy header out, because hot reload needs inline scripts.

Design tokens, components, routes, and time display aren't built yet.
