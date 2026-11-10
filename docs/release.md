# Release

How airway is versioned, released, and published as an image.

## The image

The `Dockerfile` builds the image in two stages.

1. **Build**, on `node:26-slim`: `pnpm fetch` downloads every package from the lockfile alone, so a source change reuses that layer. Then an offline install, `pnpm build`, and `pnpm deploy --prod`, which copies the server with only its production dependencies into a plain folder. The `@airway/*` packages are bundled into the server, and the web build sits in its `dist/public/`.
2. **Runtime**, on distroless `nodejs26-debian13:nonroot`: Node and its libraries, with no shell or package manager. It runs as UID 65532 and starts the server with `node --import ./dist/instrument.js dist/main.js`.

Both base images are pinned by digest, and Renovate updates the digests. The runtime image's name holds the Node major, so a new major means renaming it by hand. The pnpm version in the Dockerfile matches `mise.toml`, and Renovate updates both in one PR. The image is built for `linux/amd64` only; [#77](https://github.com/bojanrajkovic/airway/issues/77) adds arm64.

The build args `VERSION` and `GIT_SHA` become `AIRWAY_VERSION` and `AIRWAY_GIT_SHA`, which telemetry reports ([Observability](observability.md#telemetry-startup)).

Every PR builds the image and runs the image tests against it ([Testing](testing.md#image-tests)). Grype then scans it, and a high or critical finding that has a fix fails the build. A finding with no fix yet doesn't, because nothing in airway could act on it.
