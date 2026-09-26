import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  PaymentsApiService,
  checkoutActionLabel,
  checkoutProviderLabel,
} from './payments-api.service';

function setup(): { api: PaymentsApiService; http: HttpTestingController } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    api: TestBed.inject(PaymentsApiService),
    http: TestBed.inject(HttpTestingController),
  };
}

describe('PaymentsApiService', () => {
  it('downloads receipts as authenticated blobs', () => {
    const { api, http } = setup();
    let downloaded: Blob | undefined;
    api.receipt('invoice-1').subscribe((blob) => (downloaded = blob));

    const request = http.expectOne('/api/invoices/invoice-1/receipt.html');
    expect(request.request.responseType).toBe('blob');
    request.flush(new Blob(['receipt'], { type: 'text/html' }));

    expect(downloaded?.type).toBe('text/html');
    http.verify();
  });
});

describe('checkout labels', () => {
  it('uses the actual PSP without claiming every checkout is card or IRIS', () => {
    expect(checkoutProviderLabel('viva')).toBe('Viva');
    expect(checkoutActionLabel('viva')).toBe('Συνέχεια στο Viva');
    expect(checkoutActionLabel('stripe')).toBe('Πληρωμή με Stripe');
    expect(checkoutActionLabel('mercadopago')).toBe('Πληρωμή με Mercado Pago');
    expect(checkoutActionLabel('unknown')).toBe('Άνοιγμα ασφαλούς πληρωμής');
  });
});
