import { config } from "../config";

const INSECURE_JWT = new Set(["", "change-me-in-production", "changeme"]);

/** Fail fast on boot when NODE_ENV=production and required secrets/URLs are missing. */
export function validateProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;

  const issues: string[] = [];
  if (INSECURE_JWT.has(config.jwtSecret)) issues.push("JWT_SECRET_KEY");
  if (!config.tutorApiUrl || /127\.0\.0\.1|localhost/i.test(config.tutorApiUrl)) {
    issues.push("TUTOR_API_URL (must be reachable, not localhost)");
  }
  const localOnly = config.corsOrigins.every((o) => /localhost|127\.0\.0\.1/i.test(o));
  if (!config.corsOrigins.length || localOnly) {
    issues.push("CORS_ORIGINS (set your production frontend origin)");
  }
  if (!config.redisUrl || /localhost|127\.0\.0\.1/i.test(config.redisUrl)) {
    issues.push("REDIS_URL (required for multi-instance routing and session resume)");
  }

  if (!issues.length) return;
  console.error(`[voice] production config invalid:\n  - ${issues.join("\n  - ")}`);
  process.exit(1);
}
