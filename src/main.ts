import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api', { exclude: ['auth/{*path}', 'health'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  // Registered after app.init() so Nest's controller routes (health, api, auth)
  // take precedence over this catch-all — otherwise Express would match this
  // middleware first since it's mounted before Nest's own router.
  await app.init();

  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.use((req, res, next) => {
    if (
      req.method !== 'GET' ||
      req.path.startsWith('/api/') ||
      req.path.startsWith('/auth/') ||
      req.path === '/health'
    ) {
      return next();
    }
    res.sendFile(join(__dirname, '..', 'public', 'index.html'));
  });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
