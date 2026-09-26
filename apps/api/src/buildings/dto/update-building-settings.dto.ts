import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';
import {
  CURRENCY_CODES,
  MARKET_CODES,
  PSP_PROVIDERS,
} from '@org/shared';

export class UpdateBuildingSettingsDto {
  /**
   * Market-specific tax registration identifier. An empty string explicitly
   * clears the value; the service owns cross-market compatibility checks.
   */
  @ValidateIf((_object, value) => value !== '')
  @IsOptional()
  @IsString()
  @Matches(/^T[0-9]{13}$/, {
    message: 'invoiceRegistrationNo must match T + 13 digits (e.g. T1234567890123)',
  })
  invoiceRegistrationNo?: string;

  @IsOptional()
  @IsIn(MARKET_CODES)
  market?: string;

  @IsOptional()
  @IsIn(CURRENCY_CODES)
  currency?: string;

  @IsOptional()
  @IsIn(PSP_PROVIDERS)
  pspProvider?: string;
}
