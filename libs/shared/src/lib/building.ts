import type {
  CurrencyCode,
  MarketCode,
  PspProvider,
} from './market';

export interface Building {
  id: string;
  name: string;
  address?: string;
  city?: string;
  createdAt?: string;
  /** Synthetic market profile; legacy responses may omit it and imply GR. */
  market?: MarketCode;
  /** ISO-4217 currency used for all monetary fields in this building. */
  currency?: CurrencyCode;
  /** Payment service provider selected for this building. */
  pspProvider?: PspProvider | null;
  /** Market-specific tax registration identifier, when applicable. */
  invoiceRegistrationNo?: string | null;
  /** Invite/join code; omitted from public projections. */
  joinCode?: string;
}

export interface BuildingSettings {
  market: MarketCode;
  currency: CurrencyCode;
  pspProvider: PspProvider | null;
  invoiceRegistrationNo?: string | null;
}

export interface CreateBuildingDto {
  name: string;
  address?: string;
  city?: string;
  totalUnits?: number;
  market?: MarketCode;
  currency?: CurrencyCode;
  pspProvider?: PspProvider;
}

export const DEFAULT_BUILDING_NAME = 'Untitled Building';

export function createBuilding(id: string, dto: CreateBuildingDto): Building {
  return {
    id,
    name: dto.name || DEFAULT_BUILDING_NAME,
  };
}
