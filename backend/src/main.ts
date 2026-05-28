import { NestFactory } from '@nestjs/core';
import * as express from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true });
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ limit: '25mb', extended: true }));
  await app.listen(8101);
  console.log('Flowboard V1 Agent API running at http://127.0.0.1:8101');
  console.log('Extension WebSocket running at ws://127.0.0.1:9223');
}
bootstrap();
