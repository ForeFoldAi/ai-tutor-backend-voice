import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WsAdapter } from "@nestjs/platform-ws";
import { ValidationPipe } from "@nestjs/common";
import { config } from "./config";
import { validateProductionConfig } from "./common/production-config";
import { AppModule } from "./app.module";

async function bootstrap() {
  validateProductionConfig();
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(config.port);
  console.log(`voice rtc listening on ${config.port}`);
}

void bootstrap();
