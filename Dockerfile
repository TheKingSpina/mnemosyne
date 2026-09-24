FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/postgres/package.json packages/postgres/package.json
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json eslint.config.mjs vitest.config.mjs ./
COPY packages packages
COPY apps apps
RUN npm run build

FROM node:22-alpine AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages/postgres/src/schema.sql ./packages/postgres/dist/schema.sql
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

FROM node:22-alpine AS mcp
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages/postgres/src/schema.sql ./packages/postgres/dist/schema.sql
USER node
CMD ["node", "apps/mcp/dist/main.js"]

FROM node:22-alpine AS web
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/web ./apps/web
COPY --from=build /app/apps/web/src/index.html ./apps/web/dist/index.html
USER node
EXPOSE 8080
CMD ["node", "apps/web/dist/main.js"]
