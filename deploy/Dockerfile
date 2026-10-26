# Nightshift: router API + static web app in one container.
# See docs/deploy.md for the environment variables.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for this platform; the toolchain is
# only a fallback in case a prebuild is missing for the Node version in use.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci

COPY . .
RUN npm run build

# Drop dev dependencies for the runtime image.
RUN npm prune --omit=dev


FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    NIGHTSHIFT_STATIC=/app/apps/web/dist \
    NIGHTSHIFT_DB=/data/nightshift.db \
    NIGHTSHIFT_KEY=/data/router.key

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/scripts ./apps/api/scripts
COPY --from=build /app/apps/web/dist ./apps/web/dist

# /data is where the SQLite ledger and the router's signing key live.
# Mount a persistent volume here. Losing it loses balances and receipt history.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

EXPOSE 8787
CMD ["node", "apps/api/dist/server.js"]
