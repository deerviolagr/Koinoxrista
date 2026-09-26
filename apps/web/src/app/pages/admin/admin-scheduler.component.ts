import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EMPTY, catchError } from 'rxjs';
import { BuildingsApiService } from '../../core/api/buildings-api.service';
import {
  SchedulerApiService,
  SchedulerJobType,
  SchedulerRunDto,
} from '../../core/api/scheduler-api.service';
import { ToastService } from '../../ui/toast.service';

const JOB_LABELS: Record<SchedulerJobType, string> = {
  invoice_run: 'Εκκαθάριση κοινοχρήστων',
  recurring_gen: 'Παγία έξοδα',
  late_fee: 'Χρεώσεις ροπής',
  reminders: 'Υπενθυμίσεις',
  maintenance_jobs: 'Εργασίες συντήρησης',
  compliance_check: 'Έλεγχος συμμόρφωσης',
  vote_close: 'Κλείσιμο ψηφοφοριών',
  kpi_snapshot: 'Στιγμιότυπο KPI',
  kpi_anomaly: 'Έλεγχος ανωμαλιών KPI',
};

const PERIODIC_JOBS: ReadonlySet<SchedulerJobType> = new Set([
  'invoice_run',
  'recurring_gen',
  'late_fee',
]);

@Component({
  selector: 'app-admin-scheduler',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-slate-900">Προγραμματιστής εργασιών</h1>
        <p class="mt-1 text-sm text-slate-500">
          Ιστορικό εκτελέσεων για το ενεργό κτίριο και χειροκίνητη εκτέλεση.
        </p>
      </div>
      <button type="button" class="btn btn-secondary" (click)="reload()" [disabled]="loading()">
        Ανανέωση
      </button>
    </div>

    @if (loading()) {
      <div class="card text-sm text-slate-500">Φόρτωση ιστορικού…</div>
    } @else if (loadError()) {
      <div class="card border-red-200 bg-red-50 text-sm text-red-700">
        <p>Αποτυχία φόρτωσης ιστορικού προγραμματιστή.</p>
        <button type="button" class="btn btn-secondary mt-3" (click)="reload()">
          Δοκιμή ξανά
        </button>
      </div>
    } @else {
      <div class="mb-6 grid gap-4 sm:grid-cols-3">
        <div class="card">
          <p class="text-sm text-slate-500">Συνολικές εκτελέσεις</p>
          <p class="stat-value mt-1">{{ filteredRuns().length }}</p>
        </div>
        <div class="card">
          <p class="text-sm text-slate-500">Επιτυχείς</p>
          <p class="stat-value mt-1 text-emerald-700">{{ successfulCount() }}</p>
        </div>
        <div class="card">
          <p class="text-sm text-slate-500">Αποτυχίες</p>
          <p class="stat-value mt-1 text-red-700">{{ failedCount() }}</p>
        </div>
      </div>

      <div class="card mb-6">
        <h2 class="card-title">Χειροκίνητη εκτέλεση</h2>
        <p class="mb-4 text-xs text-amber-700">
          Οι ενέργειες και το ιστορικό αφορούν το ενεργό κτίριο.
        </p>
        <div class="grid gap-3 sm:grid-cols-3">
          <div>
            <label class="label" for="jobType">Ενέργεια</label>
            <select id="jobType" class="input" [ngModel]="jobType()" (ngModelChange)="jobType.set($event)">
              @for (type of jobTypes; track type) {
                <option [value]="type">{{ jobLabel(type) }}</option>
              }
            </select>
          </div>
          <div>
            <label class="label" for="period">Περίοδος (YYYY-MM)</label>
            <input
              id="period"
              type="text"
              class="input"
              [disabled]="!periodRequired()"
              [ngModel]="period()"
              (ngModelChange)="period.set($event)"
            />
          </div>
          <div class="flex items-end">
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="triggering() || !validTrigger()"
              (click)="trigger()"
            >
              {{ triggering() ? 'Εκτέλεση…' : 'Εκτέλεση' }}
            </button>
          </div>
        </div>
        @if (triggerError()) {
          <p class="field-error mt-3">{{ triggerError() }}</p>
        }
      </div>

      <div class="card overflow-x-auto p-0">
        <div class="flex flex-wrap items-center gap-3 p-4">
          <div class="w-56">
            <label class="label" for="statusFilter">Κατάσταση</label>
            <select id="statusFilter" class="input" [ngModel]="statusFilter()" (ngModelChange)="statusFilter.set($event)">
              <option value="">Όλες</option>
              <option value="SUCCESS">Επιτυχία</option>
              <option value="FAILED">Αποτυχία</option>
              <option value="RUNNING">Σε εξέλιξη</option>
            </select>
          </div>
          <div class="w-64">
            <label class="label" for="typeFilter">Ενέργεια</label>
            <select id="typeFilter" class="input" [ngModel]="typeFilter()" (ngModelChange)="typeFilter.set($event)">
              <option value="">Όλες</option>
              @for (type of jobTypes; track type) {
                <option [value]="type">{{ jobLabel(type) }}</option>
              }
            </select>
          </div>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Ενέργεια</th>
              <th>Περίοδος</th>
              <th>Κατάσταση</th>
              <th>Έναρξη</th>
              <th>Λήξη</th>
              <th>Μήνυμα</th>
            </tr>
          </thead>
          <tbody>
            @for (run of filteredRuns(); track run.id) {
              <tr>
                <td class="font-medium">{{ jobLabel(run.jobType) }}</td>
                <td>{{ run.period ?? '—' }}</td>
                <td>
                  <span class="badge" [class]="statusClass(run.status)">{{ run.status }}</span>
                </td>
                <td class="text-xs">{{ formatDate(run.startedAt) }}</td>
                <td class="text-xs">{{ run.finishedAt ? formatDate(run.finishedAt) : '—' }}</td>
                <td class="max-w-md truncate text-xs text-slate-500" [title]="run.message ?? ''">{{ run.message ?? '—' }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="6" class="py-8 text-center text-slate-500">Δεν υπάρχουν εκτελέσεις για το κτίριο.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class AdminSchedulerPage implements OnInit {
  private readonly buildingsApi = inject(BuildingsApiService);
  private readonly schedulerApi = inject(SchedulerApiService);
  private readonly toast = inject(ToastService);

  protected readonly jobTypes = Object.keys(JOB_LABELS) as SchedulerJobType[];
  protected readonly runs = signal<SchedulerRunDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly triggering = signal(false);
  protected readonly triggerError = signal<string | null>(null);
  protected readonly jobType = signal<SchedulerJobType>('invoice_run');
  protected readonly period = signal('');
  protected readonly statusFilter = signal('');
  protected readonly typeFilter = signal('');

  private buildingId: string | null = null;

  protected readonly periodRequired = computed(() => PERIODIC_JOBS.has(this.jobType()));
  protected readonly validTrigger = computed(() => {
    if (!this.periodRequired()) return true;
    return /^\d{4}-(0[1-9]|1[0-2])(?:-([0-2]\d|3[01]))?$/.test(this.period());
  });
  protected readonly filteredRuns = computed(() => {
    const buildingId = this.buildingId;
    const status = this.statusFilter();
    const type = this.typeFilter();
    return this.runs().filter(
      (run) =>
        run.buildingId === buildingId &&
        (!status || run.status === status) &&
        (!type || run.jobType === type),
    );
  });
  protected readonly successfulCount = computed(
    () => this.filteredRuns().filter((run) => run.status === 'SUCCESS').length,
  );
  protected readonly failedCount = computed(
    () => this.filteredRuns().filter((run) => run.status === 'FAILED').length,
  );

  ngOnInit(): void {
    this.loadBuilding();
  }

  protected jobLabel(type: SchedulerJobType): string {
    return JOB_LABELS[type] ?? type;
  }

  protected statusClass(status: string): string {
    switch (status) {
      case 'SUCCESS':
        return 'bg-emerald-100 text-emerald-700';
      case 'FAILED':
        return 'bg-red-100 text-red-700';
      default:
        return 'bg-amber-100 text-amber-800';
    }
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString('el-GR', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  }

  protected reload(): void {
    if (!this.buildingId) {
      this.loadBuilding();
      return;
    }
    this.loading.set(true);
    this.loadError.set(false);
    this.schedulerApi
      .history(this.buildingId, 100)
      .pipe(
        catchError(() => {
          this.loadError.set(true);
          this.loading.set(false);
          return EMPTY;
        }),
      )
      .subscribe((runs) => {
        // Keep a client-side guard as well: a server/proxy that ignores the
        // buildingId query must never leak another building's runs here.
        this.runs.set(runs);
        this.loading.set(false);
      });
  }

  protected trigger(): void {
    if (!this.buildingId || this.triggering() || !this.validTrigger()) return;
    this.triggering.set(true);
    this.triggerError.set(null);
    const period = this.periodRequired() ? this.period() : undefined;
    this.schedulerApi.trigger(this.buildingId ?? '', this.jobType(), period).subscribe({
      next: () => {
        this.triggering.set(false);
        this.toast.success('Η ενέργεια στάλθηκε για εκτέλεση.');
        this.reload();
      },
      error: (err: { error?: { message?: string } }) => {
        this.triggering.set(false);
        this.triggerError.set(err?.error?.message ?? 'Η εκτέλεση απέτυχε.');
      },
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
        this.reload();
      });
  }
}
