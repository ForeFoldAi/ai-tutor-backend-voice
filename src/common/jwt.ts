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

export function bearerToken(header?: string): string | null {
  if (!header) return null;
  const [kind, token] = header.split(" ");
  return kind?.toLowerCase() === "bearer" && token ? token : null;
}
