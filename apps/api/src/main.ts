import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as Sentry from '@sentry/nestjs';
import helmet from 'helmet';

import { AppModule } from './app/app.module';
import { corsOrigins, validateProductionConfig } from './auth/security-config';

export {
  assertProductionConfig,
  corsOrigins,
  getCorsOriginValues,
  getTwoFactorSecret,
  validateProductionConfig,
  validateSecurityConfig,
  validateStartupConfig,
} from './auth/security-config';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
  });
}

export async function bootstrap(): Promise<void> {
  validateProductionConfig();
  // rawBody is required by signature-verifying webhook providers; keeping it
  // enabled globally does not alter JSON parsing for ordinary routes.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use(
    helmet({
      contentSecurityPolicy:
        process.env.NODE_ENV === 'production' ? undefined : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.enableCors({ origin: corsOrigins(), credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);

  const swaggerEnabled =
    process.env.NODE_ENV !== 'production' ||
    process.env.SWAGGER_ENABLED === '1';
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('PolykatoikiaOS API')
      .setDescription('Building management API for Greek apartment blocks')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup(`${globalPrefix}/docs`, app, document);
    Logger.log(`📚 Swagger docs available at /${globalPrefix}/docs`);
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);
  Logger.log(
    `🚀 Application is running on: http://localhost:${port}/${globalPrefix}`,
  );
}

// Do not start a server when this module is imported by a unit test. The
// webpack/node entry still executes this in development and production.
if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
  void bootstrap();
}
