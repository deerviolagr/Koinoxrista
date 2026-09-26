import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export type SchedulerJobType =
  | 'invoice_run'
  | 'recurring_gen'
  | 'late_fee'
  | 'reminders'
  | 'maintenance_jobs'
  | 'compliance_check'
  | 'vote_close'
  | 'kpi_snapshot'
  | 'kpi_anomaly';

export interface SchedulerRunDto {
  id: string;
  buildingId: string | null;
  jobType: SchedulerJobType;
  period: string | null;
  status: string;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface SchedulerTriggerResponse {
  accepted: boolean;
}

/** Client for the existing scheduler ledger/trigger endpoints. */
@Injectable({ providedIn: 'root' })
export class SchedulerApiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/admin/scheduler`;

  history(buildingId: string, limit = 50): Observable<SchedulerRunDto[]> {
    const params = new HttpParams()
      .set('limit', String(limit))
      .set('buildingId', buildingId);
    return this.http.get<SchedulerRunDto[]>(`${this.base}/runs`, { params });
  }

  trigger(
    buildingId: string,
    jobType: SchedulerJobType,
    period?: string,
  ): Observable<SchedulerTriggerResponse> {
    const body: {
      jobType: SchedulerJobType;
      period?: string;
      buildingId: string;
    } = { jobType, buildingId };
    if (period) body.period = period;
    return this.http.post<SchedulerTriggerResponse>(
      `${this.base}/trigger`,
      body,
    );
  }
}
