import jwt from "jsonwebtoken";
import { config } from "../config";

export type AccessUser = { studentId: string; role: string };

export function verifyAccessToken(token: string): AccessUser {
  const payload = jwt.verify(token, config.jwtSecret, {
    algorithms: [config.jwtAlg as jwt.Algorithm],
  }) as jwt.JwtPayload;
  if (payload.type !== "access" || !payload.sub) {
    throw new Error("invalid token");
  }
  return { studentId: String(payload.sub), role: String(payload.role || "") };
}

/**
 * Whether FastAPI still accepts this token. A student who has signed in on another device is
 * rejected there (401) even though the JWT signature and expiry are still fine; verifyAccessToken
 * alone can't see that. Only a 401/403 counts as "no": a network error, timeout or 5xx lets the
 * call through, because a FastAPI blip must not end voice sessions (its RAG calls would fail anyway).
 */
export async function tokenAcceptedByApi(token: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(`${config.tutorApiUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    return res.status !== 401 && res.status !== 403;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export function bearerToken(header?: string): string | null {
  if (!header) return null;
  const [kind, token] = header.split(" ");
  return kind?.toLowerCase() === "bearer" && token ? token : null;
}
