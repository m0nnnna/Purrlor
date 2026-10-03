/**
 * This app's own homeserver name: the part of a user ID after the colon for people here. Anyone
 * else, a federated instance's people (docs/federation.md), keeps their server wherever a handle or
 * an address shows: `@mochi:cats.example` beside this server's `@luna`, and `/@mochi:cats.example`
 * beside `/@luna`, so two people called mochi on two instances are never mistaken for each other.
 *
 * Set once a client is ready (App.tsx), or, signed out, from the deployment's own description
 * (`GET /api/public/instance`). Unset, every handle drops its server, as before federation.
 */
let homeServer: string | undefined;

export function setHomeServer(name: string | null | undefined): void {
  homeServer = name || undefined;
}

export function getHomeServer(): string | undefined {
  return homeServer;
}

export function serverOfUserId(userId: string): string {
  const colon = userId.indexOf(':');
  return colon > 0 ? userId.slice(colon + 1) : '';
}

/** Whether `userId` is on another server than this app's (false while that isn't known). */
export function isRemoteUser(userId: string): boolean {
  return !!homeServer && !!serverOfUserId(userId) && serverOfUserId(userId) !== homeServer;
}
