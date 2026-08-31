import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { bearerToken, verifyAccessToken } from "./jwt";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      user?: { studentId: string; role: string };
    }>();
    const token = bearerToken(req.headers.authorization);
    if (!token) throw new UnauthorizedException("Sign in to start a voice session.");
    try {
      req.user = verifyAccessToken(token);
      return true;
    } catch {
      throw new UnauthorizedException("Your session ended. Please sign in again.");
    }
  }
}
