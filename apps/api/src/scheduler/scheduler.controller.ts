import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SchedulerJobType, SchedulerService } from './scheduler.service';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const OCCURRENCE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

class TriggerJobDto {
  @IsIn([
    'invoice_run',
    'recurring_gen',
    'late_fee',
    'reminders',
    'maintenance_jobs',
    'compliance_check',
    'vote_close',
    'kpi_snapshot',
    'kpi_anomaly',
  ])
  jobType!: SchedulerJobType;

  @IsOptional()
  @IsString()
  @Matches(
    new RegExp(`(?:${PERIOD_PATTERN.source}|${OCCURRENCE_PATTERN.source})`),
    {
      message: 'period must match YYYY-MM or YYYY-MM-DD',
    },
  )
  period?: string;

  /** Optional for clients that address more than one building explicitly. */
  @IsOptional()
  @IsString()
  buildingId?: string;
}

@Controller('admin/scheduler')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@UseGuards(JwtAuthGuard, RolesGuard)
export class SchedulerController {
  constructor(private readonly schedulerService: SchedulerService) {}

  @Get('runs')
  @Roles(Role.ADMIN, Role.BUILDING_OWNER)
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('buildingId') buildingId?: string,
  ) {
    const parsed = limit ? Number(limit) : undefined;
    return this.schedulerService.history(
      user,
      Number.isFinite(parsed) ? parsed : undefined,
      buildingId,
    );
  }

  @Post('trigger')
  @Roles(Role.ADMIN, Role.BUILDING_OWNER)
  async trigger(
    @Body() dto: TriggerJobDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.schedulerService.trigger(
      dto.jobType,
      user,
      dto.period,
      dto.buildingId,
    );
  }
}
