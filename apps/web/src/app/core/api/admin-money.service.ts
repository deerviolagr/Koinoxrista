import { Injectable, inject } from '@angular/core';
import { AuthService } from '../auth.service';
import { formatMoney } from '../../ui/format';

/**
 * Currency-aware money helpers for admin screens.
 *
 * The active building's currency is part of the auth/me payload. Keeping the
 * lookup here avoids every admin component accidentally falling back to the
 * legacy euro formatter after the internationalisation work.
 */
@Injectable({ providedIn: 'root' })
export class AdminMoneyService {
  private readonly auth = inject(AuthService);

  /** ISO-4217 code for the active building, with the API's EUR default. */
  readonly currency = (): string =>
    this.auth.currentUser()?.currency ?? 'EUR';

  /** Formats integer cents using the active building currency and locale. */
  format = (cents: number): string =>
    formatMoney(cents, { currency: this.currency() });
}
