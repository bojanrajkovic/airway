# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
FROM node:26.13.1-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS build
# Node dropped corepack in version 25, so npm installs pnpm. Renovate keeps PNPM_VERSION in step with mise.toml.
# renovate: datasource=npm depName=pnpm
ARG PNPM_VERSION=12.23.0
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app
# pnpm fetch reads only the lockfile, so Docker reuses this layer when only the source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm build
# Copies only the server and its production dependencies to /out.
RUN pnpm --filter @airway/server deploy --prod --offline /out

# The container runs as UID 65532.
# The image name includes the Node major version.
# When that version changes, scripts/renovate/distroless-node.sh updates the image name.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:ffa8a7545403036c94ec76674b5dbac2d425af2d679147cdf3e30180071487b7
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
# These arguments come last, so a new commit rebuilds only this layer.
ARG VERSION=dev GIT_SHA=dev
ENV AIRWAY_VERSION=$VERSION AIRWAY_GIT_SHA=$GIT_SHA
EXPOSE 3000
CMD ["--import", "./dist/instrument.js", "dist/main.js"]
