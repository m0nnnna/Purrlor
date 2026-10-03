# Builds and runs the Web Push <-> Matrix Push Gateway API bridge (docs/voice-architecture.md's
# sibling doc for push — see README.md's "Background push notifications" section).

FROM --platform=$BUILDPLATFORM node:22-alpine AS builder
WORKDIR /src

COPY services/push-gateway/package.json services/push-gateway/package-lock.json ./
RUN npm ci

COPY services/push-gateway/tsconfig.json ./
COPY services/push-gateway/src ./src
RUN npm run build


FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY services/push-gateway/package.json services/push-gateway/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /src/dist ./dist

# The commit this was built from (.github/workflows/images.yml), for `purrlor metrics` and errors. Last,
# since it changes every build.
ARG PURRLOR_VERSION=
ENV PURRLOR_VERSION=$PURRLOR_VERSION

EXPOSE 3002
CMD ["node", "dist/server.js"]
