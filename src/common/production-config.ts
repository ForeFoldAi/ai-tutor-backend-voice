import { config } from "../config";

const INSECURE_JWT = new Set(["", "change-me-in-production", "changeme"]);

export function productionConfigIssues(cfg: typeof config = config): string[] {
  const issues: string[] = [];
  if (INSECURE_JWT.has(cfg.jwtSecret)) issues.push("JWT_SECRET_KEY");
  if (!cfg.tutorApiUrl || /127\.0\.0\.1|localhost/i.test(cfg.tutorApiUrl)) {
    issues.push("TUTOR_API_URL (must be reachable, not localhost)");
  }
  const localOnly = cfg.corsOrigins.every((o) => /localhost|127\.0\.0\.1/i.test(o));
  if (!cfg.corsOrigins.length || localOnly) {
    issues.push("CORS_ORIGINS (set your production frontend origin)");
  }
  if (!cfg.redisUrl || /localhost|127\.0\.0\.1/i.test(cfg.redisUrl)) {
    issues.push("REDIS_URL (required for multi-instance routing and session resume)");
  }
  if (!cfg.voiceInternalToken) {
    issues.push("VOICE_INTERNAL_TOKEN (STT/Edge TTS fail when a student JWT expires mid-session)");
  }
  return issues;
}

/** Fail fast on boot when NODE_ENV=production and required secrets/URLs are missing. */
export function validateProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  const issues = productionConfigIssues();
  if (!issues.length) return;
  console.error(`[voice] production config invalid:\n  - ${issues.join("\n  - ")}`);
  process.exit(1);
}
