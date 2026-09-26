import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpsertProviderProfileDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  trade!: string;

  @IsArray()
  @IsString({ each: true })
  certs!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  hourlyRateCents?: number | null;
}
