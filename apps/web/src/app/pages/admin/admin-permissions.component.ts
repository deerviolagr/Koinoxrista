import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { EMPTY, catchError, forkJoin } from 'rxjs';
import { BuildingsApiService } from '../../core/api/buildings-api.service';
import {
  PermissionAdminDto,
  PermissionsApiService,
} from '../../core/api/permissions-api.service';
import { ToastService } from '../../ui/toast.service';

const PERMISSION_LABELS: Record<string, string> = {
  'billing.manage': 'Διαχείριση χρεώσεων',
  'members.manage': 'Διαχείριση μελών',
  'compliance.manage': 'Διαχείριση συμμόρφωσης',
  'legal.manage': 'Νομικές ενέργειες',
  'votes.manage': 'Διαχείριση ψηφοφοριών',
  'documents.manage': 'Διαχείριση εγγράφων',
  'treasury.manage': 'Διαχείριση ταμείου',
  'reports.view': 'Προβολή αναφορών',
  'settings.manage': 'Ρυθμίσεις κτιρίου',
};

@Component({
  selector: 'app-admin-permissions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-6">
      <h1 class="text-xl font-bold text-slate-900">Μήτρα δικαιωμάτων</h1>
      <p class="mt-1 text-sm text-slate-500">
        Οι δικαιοδοσίες κάθε διαχειριστή για το ενεργό κτίριο. Ο κάτοχος
        BUILDING_OWNER έχει όλα τα δικαιώματα.
      </p>
    </div>

    @if (loading()) {
      <div class="card text-sm text-slate-500">Φόρτωση δικαιωμάτων…</div>
    } @else if (loadError()) {
      <div class="card border-red-200 bg-red-50 text-sm text-red-700">
        <p>Αποτυχία φόρτωσης μήτρας δικαιωμάτων.</p>
        <button type="button" class="btn btn-secondary mt-3" (click)="load()">
          Δοκιμή ξανά
        </button>
      </div>
    } @else {
      <div class="card overflow-x-auto p-0">
        <table class="data-table">
          <thead>
            <tr>
              <th>Διαχειριστής</th>
              @for (key of keys(); track key) {
                <th class="min-w-36 text-center">
                  {{ permissionLabel(key) }}
                </th>
              }
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (admin of admins(); track admin.id) {
              <tr>
                <td>
                  <span class="font-medium">{{ admin.firstName }} {{ admin.lastName }}</span>
                  <span class="block text-xs text-slate-500">{{ admin.email }}</span>
                  @if (isOwner(admin)) {
                    <span class="badge mt-1 bg-indigo-100 text-indigo-700">Πλήρης πρόσβαση</span>
                  }
                </td>
                @for (key of keys(); track key) {
                  <td class="text-center">
                    <input
                      type="checkbox"
                      class="h-4 w-4"
                      [checked]="hasPermission(admin, key)"
                      [disabled]="isOwner(admin) || savingId() === admin.id"
                      [attr.aria-label]="permissionLabel(key) + ' για ' + admin.email"
                      (change)="togglePermission(admin.id, key, $event)"
                    />
                  </td>
                }
                <td>
                  @if (!isOwner(admin)) {
                    <button
                      type="button"
                      class="btn btn-primary !px-2 !py-1 text-xs"
                      [disabled]="savingId() !== null"
                      (click)="save(admin)"
                    >
                      {{ savingId() === admin.id ? 'Αποθήκευση…' : 'Αποθήκευση' }}
                    </button>
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td [attr.colspan]="keys().length + 2" class="py-8 text-center text-slate-500">
                  Δεν υπάρχουν διαχειριστές για αυτό το κτίριο.
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class AdminPermissionsPage implements OnInit {
  private readonly buildingsApi = inject(BuildingsApiService);
  private readonly permissionsApi = inject(PermissionsApiService);
  private readonly toast = inject(ToastService);

  protected readonly keys = signal<string[]>([]);
  protected readonly admins = signal<PermissionAdminDto[]>([]);
  protected readonly selected = signal<Record<string, Set<string>>>({});
  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly savingId = signal<string | null>(null);

  private buildingId: string | null = null;

  protected readonly selectedCount = computed(() =>
    this.admins().reduce((sum, admin) => sum + this.permissionsFor(admin).size, 0),
  );

  ngOnInit(): void {
    this.load();
  }

  protected permissionLabel(key: string): string {
    return PERMISSION_LABELS[key] ?? key;
  }

  protected isOwner(admin: PermissionAdminDto): boolean {
    return admin.role === 'BUILDING_OWNER';
  }

  protected permissionsFor(admin: PermissionAdminDto): ReadonlySet<string> {
    return this.selected()[admin.id] ?? new Set(admin.permissions);
  }

  protected hasPermission(admin: PermissionAdminDto, key: string): boolean {
    return this.isOwner(admin) || this.permissionsFor(admin).has(key);
  }

  protected togglePermission(
    adminId: string,
    key: string,
    event: Event,
  ): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.selected.update((current) => {
      const next = new Set(current[adminId] ?? []);
      if (checked) next.add(key);
      else next.delete(key);
      return { ...current, [adminId]: next };
    });
  }

  protected save(admin: PermissionAdminDto): void {
    if (!this.buildingId || this.savingId() || this.isOwner(admin)) return;
    const permissions = [...(this.selected()[admin.id] ?? new Set(admin.permissions))];
    this.savingId.set(admin.id);
    this.permissionsApi.set(this.buildingId, admin.id, permissions).subscribe({
      next: () => {
        this.savingId.set(null);
        this.toast.success(`Οι δικαιοδοσίες του ${admin.email} αποθηκεύτηκαν.`);
        this.load();
      },
      error: (err: { error?: { message?: string } }) => {
        this.savingId.set(null);
        this.toast.error(err?.error?.message ?? 'Η αποθήκευση δικαιωμάτων απέτυχε.');
      },
    });
  }

  protected load(): void {
    if (!this.buildingId) {
      this.loadBuilding();
      return;
    }
    this.loading.set(true);
    this.loadError.set(false);
    forkJoin({
      keys: this.permissionsApi.keys(this.buildingId),
      admins: this.permissionsApi.admins(this.buildingId),
    })
      .pipe(
        catchError(() => {
          this.loadError.set(true);
          this.loading.set(false);
          return EMPTY;
        }),
      )
      .subscribe(({ keys, admins }) => {
        this.keys.set(keys);
        this.admins.set(admins);
        this.selected.set(
          Object.fromEntries(admins.map((admin) => [admin.id, new Set(admin.permissions)])),
        );
        this.loading.set(false);
      });
  }

  private loadBuilding(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.buildingsApi
      .mine()
      .pipe(
        catchError(() => {
          this.loadError.set(true);
          this.loading.set(false);
          return EMPTY;
        }),
      )
      .subscribe((building) => {
        this.buildingId = building.id;
        this.load();
      });
  }
}
