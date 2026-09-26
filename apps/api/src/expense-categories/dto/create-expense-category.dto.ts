import {
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { AllocationStrategy } from '@prisma/client';
import { SUPPORTED_ALLOCATION_STRATEGIES } from '../../expenses/allocation-weights';

export class CreateExpenseCategoryDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsIn(SUPPORTED_ALLOCATION_STRATEGIES)
  strategy?: AllocationStrategy;
}
