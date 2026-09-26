import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import { AdminMoneyService } from '../../core/api/admin-money.service';
import { BuildingsApiService } from '../../core/api/buildings-api.service';
import { JobsApiService } from '../../core/api/jobs-api.service';
import { SchedulerApiService } from '../../core/api/scheduler-api.service';
import { AuthService } from '../../core/auth.service';
import { formatMoney } from '../../ui/format';
import { meterReadingKey } from './admin-meters.component';

describe('admin component fixes', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  it('keeps meter edits isolated by billing period', () => {
    expect(meterReadingKey('2026-08', 'unit-1', 'WATER')).not.toBe(
      meterReadingKey('2026-09', 'unit-1', 'WATER'),
    );
    expect(meterReadingKey('2026-08', 'unit-1', 'WATER')).toBe(
      '2026-08|unit-1|WATER',
    );
  });

  it('formats money with the active building currency', () => {
    const auth = TestBed.inject(AuthService);
    auth.currentUser.set({
      id: 'admin-1',
      email: 'admin@example.test',
      role: 'ADMIN',
      buildingId: 'building-1',
      currency: 'USD',
    });
    const money = TestBed.inject(AdminMoneyService);
    expect(money.format(12345)).toBe(
      formatMoney(12345, { currency: 'USD', locale: 'el-GR' }),
    );
  });

  it('sends null when clearing the optional invoice registration number', () => {
    const api = TestBed.inject(BuildingsApiService);
    api
      .updateSettings('building-1', {
        market: 'US',
        currency: 'USD',
        pspProvider: 'stripe',
        invoiceRegistrationNo: null,
      })
      .subscribe();
    const request = TestBed.inject(HttpTestingController).expectOne(
      '/api/buildings/building-1/settings',
    );
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body.invoiceRegistrationNo).toBeNull();
    request.flush({ id: 'building-1', name: 'Building' });
  });

  it('uses the existing building-scoped scheduler endpoints', () => {
    const api = TestBed.inject(SchedulerApiService);
    api.history('building-1', 25).subscribe();
    const history = TestBed.inject(HttpTestingController).expectOne(
      (req) => req.url === '/api/admin/scheduler/runs',
    );
    expect(history.request.params.get('buildingId')).toBe('building-1');
    expect(history.request.params.get('limit')).toBe('25');
    history.flush([]);

    api.trigger('building-1', 'invoice_run', '2026-08').subscribe();
    const trigger = TestBed.inject(HttpTestingController).expectOne(
      '/api/admin/scheduler/trigger',
    );
    expect(trigger.request.body).toEqual({
      jobType: 'invoice_run',
      period: '2026-08',
      buildingId: 'building-1',
    });
    trigger.flush({ accepted: true });
  });

  it('exposes the existing defect-to-RFP conversion endpoint', () => {
    const api = TestBed.inject(JobsApiService);
    api.convertToRfp('job-1').subscribe();
    const request = TestBed.inject(HttpTestingController).expectOne(
      '/api/jobs/job-1/convert',
    );
    expect(request.request.method).toBe('POST');
    request.flush({ id: 'job-1', buildingId: 'building-1', title: 'Fix', description: 'Fix', status: 'OPEN' });
  });
});
