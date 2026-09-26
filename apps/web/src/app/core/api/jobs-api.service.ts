import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  Bid,
  BidStatus,
  CreateBidDto,
  CreateDefectDto,
  CreateJobDto,
  CreateWorkLogDto,
  Job,
  JobStatus,
  WorkLogView,
} from '@org/shared';
import { environment } from '../../../environments/environment';

/** Job row for admins, including its bids. */
export interface JobWithBids extends Job {
  bids?: Bid[];
  /** Present when the API can identify the resident who submitted a report. */
  reportedById?: string | null;
}

/** Stable provider job row; `bids` contains only the caller's own offers. */
export interface ProviderMarketJob {
  id: string;
  buildingId: string;
  buildingName: string;
  title: string;
  description: string;
  status: JobStatus;
  budgetCents: number | null;
  bids: Bid[];
  /** Expected on newer API builds; older builds fall back to active currency. */
  currency?: string;
}

/** Bid projection returned to the provider who owns it. */
export type ProviderBidView = Bid;

/** GET /jobs/mine keeps the stable job row plus legacy nested compatibility fields. */
export interface ProviderMineJob extends ProviderMarketJob {
  job: {
    id: string;
    title: string;
    status: JobStatus;
    buildingName: string;
  };
  bid: ProviderBidView;
}

/** Provider profile as persisted by the API; GET returns null before creation. */
export interface ProviderProfile {
  userId?: string;
  trade: string | null;
  certs: string[];
  rating: number | null;
  city?: string | null;
  bio?: string | null;
  hourlyRateCents?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Exact upsert contract accepted by the current provider-profile endpoint. */
export interface ProviderProfilePayload {
  trade: string;
  certs: string[];
}

/** Badge style for a job status (cls + label). */
export function jobStatusBadge(status: JobStatus): {
  cls: string;
  label: string;
} {
  switch (status) {
    case 'OPEN':
      return { cls: 'bg-blue-100 text-blue-800', label: 'Ανοιχτή' };
    case 'AWARDED':
      return { cls: 'bg-amber-100 text-amber-800', label: 'Ανατέθηκε' };
    case 'IN_PROGRESS':
      return { cls: 'bg-indigo-100 text-indigo-700', label: 'Σε εξέλιξη' };
    case 'COMPLETED':
      return { cls: 'bg-green-100 text-green-800', label: 'Ολοκληρώθηκε' };
    default:
      return { cls: 'bg-slate-200 text-slate-600', label: 'Ακυρώθηκε' };
  }
}

/** Badge style for a bid status. */
export function bidStatusBadge(status: BidStatus): {
  cls: string;
  label: string;
} {
  switch (status) {
    case 'ACCEPTED':
      return { cls: 'bg-green-100 text-green-800', label: 'Εγκεκριμένη' };
    case 'REJECTED':
      return { cls: 'bg-red-100 text-red-700', label: 'Απορρίφθηκε' };
    default:
      return { cls: 'bg-slate-200 text-slate-700', label: 'Υπό εξέταση' };
  }
}

@Injectable({ providedIn: 'root' })
export class JobsApiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}`;

  listForBuilding(buildingId: string): Observable<JobWithBids[]> {
    return this.http.get<JobWithBids[]>(
      `${this.base}/buildings/${buildingId}/jobs`,
    );
  }

  create(buildingId: string, dto: CreateJobDto): Observable<Job> {
    return this.http.post<Job>(
      `${this.base}/buildings/${buildingId}/jobs`,
      dto,
    );
  }

  /** PROVIDER: public jobs open for bidding (no private bid data). */
  marketplace(): Observable<ProviderMarketJob[]> {
    return this.http.get<ProviderMarketJob[]>(`${this.base}/jobs/marketplace`);
  }

  /** PROVIDER: job/bid pairs for every bid owned by the current provider. */
  mine(): Observable<ProviderMineJob[]> {
    return this.http.get<ProviderMineJob[]>(`${this.base}/jobs/mine`);
  }

  createBid(jobId: string, dto: CreateBidDto): Observable<ProviderBidView> {
    return this.http.post<ProviderBidView>(
      `${this.base}/jobs/${jobId}/bids`,
      dto,
    );
  }

  acceptBid(bidId: string): Observable<Bid> {
    return this.http.post<Bid>(`${this.base}/bids/${bidId}/accept`, {});
  }

  rejectBid(bidId: string): Observable<Bid> {
    return this.http.post<Bid>(`${this.base}/bids/${bidId}/reject`, {});
  }

  addWorkLog(jobId: string, dto: CreateWorkLogDto): Observable<WorkLogView> {
    return this.http.post<WorkLogView>(
      `${this.base}/jobs/${jobId}/work-logs`,
      dto,
    );
  }

  workLogs(jobId: string): Observable<WorkLogView[]> {
    return this.http.get<WorkLogView[]>(`${this.base}/jobs/${jobId}/work-logs`);
  }

  complete(jobId: string): Observable<Job> {
    return this.http.post<Job>(`${this.base}/jobs/${jobId}/complete`, {});
  }

  /** Converts a resident report into the public RFP marketplace. */
  convertToRfp(jobId: string): Observable<JobWithBids> {
    return this.http.post<JobWithBids>(
      `${this.base}/jobs/${jobId}/convert`,
      {},
    );
  }

  rate(jobId: string, stars: number): Observable<Job> {
    return this.http.post<Job>(`${this.base}/jobs/${jobId}/rating`, { stars });
  }

  /** RESIDENT: report a defect for the active building. */
  createDefect(buildingId: string, dto: CreateDefectDto): Observable<Job> {
    return this.http.post<Job>(
      `${this.base}/buildings/${buildingId}/defects`,
      dto,
    );
  }
}

@Injectable({ providedIn: 'root' })
export class ProviderProfileApiService {
  private readonly http = inject(HttpClient);

  get(): Observable<ProviderProfile | null> {
    return this.http.get<ProviderProfile | null>(
      `${environment.apiUrl}/provider/profile`,
    );
  }

  update(profile: ProviderProfilePayload): Observable<ProviderProfile> {
    return this.http.put<ProviderProfile>(
      `${environment.apiUrl}/provider/profile`,
      profile,
    );
  }
}
