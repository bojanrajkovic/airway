// Deliberate violations of the React rules Oxlint turns off by default, so tests/lint.test.ts
// proves the web override turns them on. `pnpm lint` skips this directory.
import { useEffect, useState } from "react";

type Props = { id: string; show: boolean };

// react/rules-of-hooks: a hook inside a condition
export function ConditionalHook({ show }: Props): React.JSX.Element | null {
  if (show) {
    const [value] = useState(0);

    return <p>{value}</p>;
  }

  return null;
}

// react/exhaustive-deps: the effect reads `id` but doesn't list it
export function MissingDependency({ id }: Props): React.JSX.Element {
  useEffect(() => {
    document.title = id;
  }, []);

  return <p>{id}</p>;
}

// react/purity (React Compiler): an impure call during render
export function Clock(): React.JSX.Element {
  return <p>{Date.now()}</p>;
}

// jsx-a11y/alt-text: an image without alt text
export function Picture(): React.JSX.Element {
  return <img src="/picture.png" />;
}
