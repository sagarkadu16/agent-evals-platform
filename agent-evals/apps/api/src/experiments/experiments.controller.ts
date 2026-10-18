import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ExperimentsService, type CreateExperimentBody } from './experiments.service.js';

@Controller()
export class ExperimentsController {
  constructor(private readonly experiments: ExperimentsService) {}

  @Post('experiments')
  create(@Body() body: CreateExperimentBody) {
    return this.experiments.create(body);
  }

  @Get('experiments')
  list() {
    return this.experiments.list();
  }

  @Get('experiments/:id')
  get(@Param('id') id: string) {
    return this.experiments.get(id);
  }

  @Get('experiments/:id/summary')
  summary(@Param('id') id: string) {
    return this.experiments.summary(id);
  }

  @Post('experiments/:id/retry-errors')
  @HttpCode(200)
  retryErrors(@Param('id') id: string) {
    return this.experiments.retryErrors(id);
  }

  @Get('runs/:id')
  run(@Param('id') id: string) {
    return this.experiments.getRun(id);
  }
}
