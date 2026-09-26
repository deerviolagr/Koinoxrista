import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateOwnershipDto {
  @IsString()
  userId!: string;

  @IsInt()
  @Min(1)
  shareMillimes!: number;

  @IsOptional()
  @IsISO8601()
  periodStart?: string | null;

  /** Optional inclusive end of the ownership period. */
  @IsOptional()
  @IsISO8601()
  periodEnd?: string | null;
}
