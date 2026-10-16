import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { DatabaseModule } from './db/database.module.js';
import { CatalogModule } from './catalog/catalog.module.js';

@Module({
  imports: [DatabaseModule, CatalogModule],
  controllers: [AppController],
})
export class AppModule {}
