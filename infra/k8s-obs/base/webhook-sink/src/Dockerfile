# Multi-stage build for the local-dev Alertmanager webhook sink.
# Build stage installs production dependencies; runtime stage copies them
# alongside the server source into a minimal Alpine image.
FROM node:22.11-alpine AS build
WORKDIR /build
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22.11-alpine AS runtime
WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY package.json server.js ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
