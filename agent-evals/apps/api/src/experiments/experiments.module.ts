import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { RunnerModule } from '../runner/runner.module.js';
import { ScoringModule } from '../scoring/scoring.module.js';
import { ExecutorService } from './executor.service.js';
import { ExperimentsController } from './experiments.controller.js';
import { ExperimentsService } from './experiments.service.js';

@Module({
  imports: [CatalogModule, RunnerModule, ScoringModule],
  controllers: [ExperimentsController],
  providers: [ExperimentsService, ExecutorService],
})
export class ExperimentsModule {}
