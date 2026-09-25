# DuoSpace Call Gateway — signaling server (Phase 1 scaffold).
# NOT RUNTIME-VERIFIED — never built/run in any sandbox this project has
# used; standard Node multi-stage build, nothing project-specific beyond
# that.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
RUN npm install --omit=dev
EXPOSE 8787
CMD ["node", "dist/server.js"]
