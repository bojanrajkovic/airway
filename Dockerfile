# syntax=docker/dockerfile:1
FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
# Node 25+ no longer bundles corepack. Keep this on the same version as mise.toml; Renovate updates
# both in one PR.
# renovate: datasource=npm depName=pnpm
ARG PNPM_VERSION=12.16.1
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app
# fetch reads only the lockfile, so a source change keeps this download layer cached. It fills the
# store with every package, dev ones included.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm build
# The server with only its production dependencies, as a plain folder. The web build is already in
# its dist/public, and the @airway packages are bundled into dist.
RUN pnpm --filter @airway/server deploy --prod --offline /out

# Node and its runtime libraries only: no shell, no package manager. It runs as UID 65532.
# shortcut: the image name holds the Node major, which Renovate can't change; rename it by hand
# when mise.toml moves to a new major. Renovate updates the digest.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:33c86a63859efc2ebd88ea0a355863582ec6f1220d048de62baffb2584e709b3
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
# Last, so a new commit changes only this layer. Telemetry reports them as service.version and
# vcs.ref.head.revision.
ARG VERSION=dev GIT_SHA=dev
ENV AIRWAY_VERSION=$VERSION AIRWAY_GIT_SHA=$GIT_SHA
EXPOSE 3000
# The image's entrypoint is node.
CMD ["--import", "./dist/instrument.js", "dist/main.js"]
