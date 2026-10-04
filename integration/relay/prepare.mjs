import { execFileSync } from "node:child_process";

// Immutable OCI digests match tests/environment/support/relay-service.ts.
const images = [
  "scsibug/nostr-rs-relay@sha256:48d54c2d2781577cf3ed2951112f0953dc2c5e7c9d2ea20c64e8c0fa37d16e4d",
  "dockurr/strfry@sha256:599ab3500dbfbe6cb78c668e1892cd9802c192d066df4660e8e3175034a8344d",
];
for (const image of images)
  execFileSync(process.env.NOSTRBASE_DOCKER ?? "docker", ["pull", image], { stdio: "inherit" });
