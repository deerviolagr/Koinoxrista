import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface PermissionAdminDto {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  permissions: string[];
}

/** Existing building-scoped granular permission endpoints. */
@Injectable({ providedIn: 'root' })
export class PermissionsApiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/buildings`;

  keys(buildingId: string): Observable<string[]> {
    return this.http.get<string[]>(
      `${this.base}/${buildingId}/permissions/keys`,
    );
  }

  admins(buildingId: string): Observable<PermissionAdminDto[]> {
    return this.http.get<PermissionAdminDto[]>(
      `${this.base}/${buildingId}/permissions/admins`,
    );
  }

  set(
    buildingId: string,
    userId: string,
    permissions: string[],
  ): Observable<void> {
    return this.http.post<void>(
      `${this.base}/${buildingId}/permissions/admins/${userId}`,
      { keys: permissions },
    );
  }
}
