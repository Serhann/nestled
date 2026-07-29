# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# prisma/ must exist before install: the postinstall hook runs `prisma generate`.
COPY prisma ./prisma
RUN npm install
COPY tsconfig.json ./
COPY src ./src
# `build` = prisma generate && tsc.
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
# Schema + migrations are needed at runtime for `prisma migrate deploy` (run on
# boot) and for the postinstall `prisma generate`.
COPY prisma ./prisma
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# No EXPOSE.
#
# This service is reached only over the compose network, by `web`. Declaring the
# port makes orchestrators — Coolify among them — offer to give it a public
# domain, and a backend that is publicly routable alongside the proxy is a way to
# reach the API with the proxy's rules skipped. It listens on 4000 regardless.
CMD ["node", "dist/index.js"]
