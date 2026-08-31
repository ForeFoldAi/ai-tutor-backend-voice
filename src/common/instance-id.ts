import { hostname } from "os";

/** Stable per-process id for Redis session ownership (pod name or host+pid). */
export function instanceId(): string {
  const fromEnv = (process.env.INSTANCE_ID || process.env.HOSTNAME || "").trim();
  if (fromEnv) return fromEnv;
  return `${hostname()}:${process.pid}`;
}
