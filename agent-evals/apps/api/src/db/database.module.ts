import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { SeedService } from './seed.service.js';

@Global()
@Module({
  providers: [DatabaseService, SeedService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
