# syntax=docker/dockerfile:1
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
# Node 25+ has no corepack. Renovate keeps this in step with mise.toml.
# renovate: datasource=npm depName=pnpm
ARG PNPM_VERSION=12.18.0
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app
# Reads only the lockfile, so source changes keep this layer cached.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm build
# The server and its production dependencies only.
RUN pnpm --filter @airway/server deploy --prod --offline /out

# Runs as UID 65532.
# shortcut: the name holds the Node major, which Renovate can't change; rename it on a new major.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:767ffb7e2ffa9f4280f1af7b99f7f0a1cafb79d0dcc0e0d3aba43843748008a5
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
# Last, so a new commit changes only this layer.
ARG VERSION=dev GIT_SHA=dev
ENV AIRWAY_VERSION=$VERSION AIRWAY_GIT_SHA=$GIT_SHA
EXPOSE 3000
CMD ["--import", "./dist/instrument.js", "dist/main.js"]
