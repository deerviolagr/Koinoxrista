import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** Matches the shared `PlanPaymentDto` shape for request validation. */
export class RecordPlanPaymentDto {
  @IsInt()
  @Min(1)
  amountCents!: number;

  /**
   * Stable client/request key.  Replaying the same key returns the original
   * settlement instead of creating another Payment row.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;
}
