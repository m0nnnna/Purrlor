# Builds and runs the Matrix-membership-gated LiveKit token server (docs/voice-architecture.md).

FROM --platform=$BUILDPLATFORM node:22-alpine AS builder
WORKDIR /src

COPY services/token-server/package.json services/token-server/package-lock.json ./
RUN npm ci

COPY services/token-server/tsconfig.json ./
COPY services/token-server/src ./src
RUN npm run build


FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY services/token-server/package.json services/token-server/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /src/dist ./dist

# The commit this was built from (.github/workflows/images.yml), for `purrlor metrics` and errors. Last,
# since it changes every build.
ARG PURRLOR_VERSION=
ENV PURRLOR_VERSION=$PURRLOR_VERSION

EXPOSE 3001
CMD ["node", "dist/server.js"]
