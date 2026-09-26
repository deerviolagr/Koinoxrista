import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  CreatePaymentOrderResponse,
  Invoice,
  PaymentOrder,
  PaymentStatus,
} from '@org/shared';
import { environment } from '../../../environments/environment';

export type CheckoutProvider =
  'viva' | 'stripe' | 'stripejp' | 'mercadopago' | 'gmo' | (string & {});

export interface CreateCheckoutResponse extends CreatePaymentOrderResponse {
  /** PSP selected by the building; absent only on older API builds. */
  provider?: CheckoutProvider;
}

export function checkoutProviderLabel(
  provider: string | null | undefined,
): string {
  switch (provider?.toLowerCase()) {
    case 'viva':
      return 'Viva';
    case 'stripe':
      return 'Stripe';
    case 'stripejp':
      return 'Stripe Japan';
    case 'mercadopago':
      return 'Mercado Pago';
    case 'gmo':
      return 'GMO Payment Gateway';
    default:
      return provider || 'Σύστημα πληρωμής';
  }
}

export function checkoutActionLabel(
  provider: string | null | undefined,
): string {
  switch (provider?.toLowerCase()) {
    case 'viva':
      return 'Συνέχεια στο Viva';
    case 'stripe':
    case 'stripejp':
      return 'Πληρωμή με Stripe';
    case 'mercadopago':
      return 'Πληρωμή με Mercado Pago';
    case 'gmo':
      return 'Πληρωμή με GMO';
    default:
      return 'Άνοιγμα ασφαλούς πληρωμής';
  }
}

/** A recorded payment on an invoice (joined by the API in invoice detail). */
export interface InvoicePaymentView {
  id: string;
  amountCents: number;
  method: string | null;
  status: PaymentStatus;
  pspRef: string | null;
  createdAt?: string;
}

/** Invoice detail including its payments and checkout orders. */
export interface InvoiceDetailView extends Invoice {
  payments: InvoicePaymentView[];
  orders: PaymentOrder[];
}

@Injectable({ providedIn: 'root' })
export class PaymentsApiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/invoices`;

  /** Creates a PSP checkout order for the (remaining) invoice amount. */
  pay(invoiceId: string): Observable<CreateCheckoutResponse> {
    return this.http.post<CreateCheckoutResponse>(
      `${this.base}/${invoiceId}/pay`,
      {},
    );
  }

  detail(invoiceId: string): Observable<InvoiceDetailView> {
    return this.http.get<InvoiceDetailView>(`${this.base}/${invoiceId}`);
  }

  /** Authenticated receipt download; a plain href would omit the bearer token. */
  receipt(invoiceId: string): Observable<Blob> {
    return this.http.get(`${this.base}/${invoiceId}/receipt.html`, {
      responseType: 'blob' as const,
    });
  }

  /** Human label for a payment method code (CARD / IRIS / PIX / …). */
  methodLabel(method: string | null | undefined): string {
    switch (method) {
      case 'CARD':
        return 'Κάρτα';
      case 'IRIS':
        return 'IRIS';
      case 'PIX':
        return 'PIX';
      case 'ACH':
        return 'ACH';
      case 'SPEI':
        return 'SPEI';
      case 'SEPA_DD':
        return 'SEPA Direct Debit';
      case 'INTERAC':
        return 'Interac';
      default:
        return method || '—';
    }
  }
}
