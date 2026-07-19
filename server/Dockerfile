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
EXPOSE 4000
CMD ["node", "dist/index.js"]
