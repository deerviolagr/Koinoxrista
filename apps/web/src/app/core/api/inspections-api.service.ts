import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export type InspectionResult = 'OK' | 'NG' | 'REPAIR_NEEDED';

export interface InspectionRecordDto {
  id: string;
  assetId: string;
  buildingId: string;
  inspectedAt: string;
  inspectorName: string | null;
  result: InspectionResult;
  photoKey: string | null;
  notes: string | null;
  jobId: string | null;
  createdAt: string;
}

export interface CreateInspectionDto {
  inspectedAt?: string;
  result: InspectionResult;
  photoKey?: string;
  notes?: string;
  jobId?: string;
}

/** Existing asset inspection history endpoints. */
@Injectable({ providedIn: 'root' })
export class InspectionsApiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/buildings`;

  list(buildingId: string, assetId: string): Observable<InspectionRecordDto[]> {
    return this.http.get<InspectionRecordDto[]>(
      `${this.base}/${buildingId}/assets/${assetId}/inspections`,
    );
  }

  create(
    buildingId: string,
    assetId: string,
    dto: CreateInspectionDto,
  ): Observable<InspectionRecordDto> {
    return this.http.post<InspectionRecordDto>(
      `${this.base}/${buildingId}/assets/${assetId}/inspections`,
      dto,
    );
  }

  remove(
    buildingId: string,
    assetId: string,
    inspectionId: string,
  ): Observable<void> {
    return this.http.delete<void>(
      `${this.base}/${buildingId}/assets/${assetId}/inspections/${inspectionId}`,
    );
  }
}
