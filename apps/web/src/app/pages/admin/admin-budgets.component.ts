import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { EMPTY, catchError, forkJoin } from 'rxjs';
import type {
  BudgetCompareResponseDto,
  BudgetLineDto,
  ExpenseCategory,
} from '@org/shared';
import { AdminMoneyService } from '../../core/api/admin-money.service';
import { BuildingsApiService } from '../../core/api/buildings-api.service';
import { BudgetsApiService } from '../../core/api/budgets-api.service';
import { CategoriesApiService } from '../../core/api/categories-api.service';
import { eurosToCents } from '../../ui/format';
import { ToastService } from '../../ui/toast.service';

@Component({
  selector: 'app-admin-budgets',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="mb-6 text-xl font-bold text-slate-900">Προϋπολογισμός</h1>

    <div class="mb-6 flex flex-wrap items-end gap-3">
      <div>
        <label class="label" for="year">Έτος</label>
        <select id="year" class="input" [formControl]="yearCtrl">
          @for (y of years; track y) {
            <option [value]="y">{{ y }}</option>
          }
        </select>
      </div>
    </div>

    <div class="grid gap-6 lg:grid-cols-3">
      <div class="card lg:col-span-1">
        <h2 class="card-title">Νέα γραμμή προϋπολογισμού</h2>
        <form [formGroup]="form" (ngSubmit)="save()" class="flex flex-col gap-4">
          <div>
            <label class="label" for="name">Όνομα</label>
            <input
              id="name"
              type="text"
              class="input"
              formControlName="name"
              placeholder="π.χ. Συντήρηση ανελκυστήρα"
            />
            @if (submitted() && form.controls.name.invalid) {
              <p class="field-error">Το όνομα είναι υποχρεωτικό.</p>
            }
          </div>
          <div>
            <label class="label" for="amount">Προβλεπόμενο ποσό ({{ currency() }})</label>
            <input
              id="amount"
              type="number"
              min="0"
              step="0.01"
              class="input"
              formControlName="amount"
            />
            @if (submitted() && form.controls.amount.invalid) {
              <p class="field-error">Δώστε έγκυρο ποσό.</p>
            }
          </div>
          <div>
            <label class="label" for="categoryId">Κατηγορία (προαιρετικό)</label>
            <select id="categoryId" class="input" formControlName="categoryId">
              <option value="">— Χωρίς κατηγορία —</option>
              @for (category of categories(); track category.id) {
                <option [value]="category.id">{{ category.name }}</option>
              }
            </select>
          </div>
          <button type="submit" class="btn btn-primary self-start" [disabled]="saving()">
            Προσθήκη
          </button>
        </form>
      </div>

      <div class="card overflow-x-auto p-0 lg:col-span-2">
        @if (loading()) {
          <div class="p-6 text-sm text-slate-500">Φόρτωση…</div>
        } @else if (loadError()) {
          <div class="border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <p>Αποτυχία φόρτωσης προϋπολογισμού.</p>
            <button type="button" class="btn btn-secondary mt-3" (click)="retry()">
              Δοκιμή ξανά
            </button>
          </div>
        } @else {
          <table class="data-table">
          <thead>
            <tr>
              <th>Όνομα</th>
              <th>Κατηγορία</th>
              <th>Ποσό</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (line of lines(); track line.id) {
              <tr>
                <td class="font-medium">{{ line.name }}</td>
                <td>{{ categoryName(line.categoryId) }}</td>
                <td>{{ euros(line.plannedCents) }}</td>
                <td>
                  <button
                    type="button"
                    class="btn btn-secondary !px-2 !py-1 text-xs text-red-600"
                    (click)="remove(line)"
                  >
                    Διαγραφή
                  </button>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="4" class="py-8 text-center text-slate-500">
                  Δεν υπάρχουν γραμμές για {{ year() }}.
                </td>
              </tr>
            }
          </tbody>
          </table>
        }
      </div>
    </div>

    <div class="card mt-6 overflow-x-auto p-0">
      <h2 class="card-title px-4 pt-4">Προϋπολογισμός έναντι πραγματικών</h2>
      @if (loadError()) {
        <div class="m-4 border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p>Αποτυχία φόρτωσης σύγκρισης.</p>
          <button type="button" class="btn btn-secondary mt-2" (click)="retry()">Δοκιμή ξανά</button>
        </div>
      } @else {
      <table class="data-table">
        <thead>
          <tr>
            <th>Κατηγορία</th>
            <th>Προϋπολογισμός</th>
            <th>Πραγματικά</th>
            <th>Διαφορά</th>
          </tr>
        </thead>
        <tbody>
          @for (row of compare().lines; track row.categoryId) {
            <tr>
              <td class="font-medium">
                {{ row.categoryName }}
                @if (row.name) {
                  <span class="block text-xs font-normal text-slate-500">
                    {{ row.name }}
                  </span>
                }
              </td>
              <td>{{ euros(row.plannedCents) }}</td>
              <td>{{ euros(row.actualCents) }}</td>
              <td
                [class]="row.actualCents > row.plannedCents
                  ? 'font-medium text-red-600'
                  : 'font-medium text-emerald-600'"
              >
                {{ euros(row.actualCents - row.plannedCents) }}
              </td>
            </tr>
          } @empty {
            <tr>
              <td colspan="4" class="py-8 text-center text-slate-500">
                Χωρίς δεδομένα για {{ year() }}.
              </td>
            </tr>
          }
        </tbody>
        @if (compare().lines.length > 0) {
          <tfoot>
            <tr class="font-semibold">
              <td>Σύνολο</td>
              <td>{{ euros(compare().totals.plannedCents) }}</td>
              <td>{{ euros(compare().totals.actualCents) }}</td>
              <td>{{ euros(compare().totals.actualCents - compare().totals.plannedCents) }}</td>
            </tr>
          </tfoot>
        }
      </table>
      }
    </div>
  `,
})
export class AdminBudgetsPage implements OnInit {
  private readonly buildingsApi = inject(BuildingsApiService);
  private readonly budgetsApi = inject(BudgetsApiService);
  private readonly categoriesApi = inject(CategoriesApiService);
  private readonly money = inject(AdminMoneyService);
  private readonly toast = inject(ToastService);
  private readonly fb = inject(FormBuilder);

  protected readonly euros = (cents: number): string => this.money.format(cents);
  protected readonly currency = this.money.currency;

  protected readonly currentYear = new Date().getFullYear();
  protected readonly years = Array.from(
    { length: 5 },
    (_, i) => this.currentYear - i,
  );

  protected readonly yearCtrl = this.fb.nonNullable.control(
    String(this.currentYear),
  );
  private readonly yearValue = toSignal(this.yearCtrl.valueChanges, {
    initialValue: this.yearCtrl.value,
  });

  protected readonly loading = signal(true);
  protected readonly lines = signal<BudgetLineDto[]>([]);
  protected readonly categories = signal<ExpenseCategory[]>([]);
  protected readonly compare = signal<BudgetCompareResponseDto>({
    year: this.currentYear,
    lines: [],
    totals: { plannedCents: 0, actualCents: 0 },
  });
  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly loadError = signal(false);

  protected readonly year = computed(() => Number(this.yearValue()));

  protected readonly form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    amount: this.fb.nonNullable.control<number | null>(null, {
      validators: [Validators.required, Validators.min(0)],
    }),
    categoryId: [''],
  });

  private buildingId: string | null = null;

  ngOnInit(): void {
    this.yearCtrl.valueChanges.subscribe(() => this.reload());
    this.loadBuilding();
  }

  protected retry(): void {
    this.loadBuilding();
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
        this.categoriesApi
          .list(building.id)
          .pipe(
            catchError(() => {
              this.loadError.set(true);
              this.loading.set(false);
              return EMPTY;
            }),
          )
          .subscribe((categories) => this.categories.set(categories));
        this.reload();
      });
  }

  protected categoryName(categoryId: string | null | undefined): string {
    if (!categoryId) return '—';
    return (
      this.categories().find((category) => category.id === categoryId)?.name ??
      '—'
    );
  }

  protected save(): void {
    this.submitted.set(true);
    if (!this.buildingId || this.form.invalid || this.saving()) return;
    const { name, amount, categoryId } = this.form.getRawValue();
    const cents = eurosToCents(amount ?? NaN);
    if (!Number.isFinite(cents) || cents < 0) return;
    this.saving.set(true);
    this.budgetsApi
      .create(this.buildingId, {
        year: this.year(),
        name: name.trim(),
        plannedCents: cents,
        ...(categoryId ? { categoryId } : {}),
      })
      .subscribe({
        next: () => {
          this.toast.success('Η γραμμή προστέθηκε.');
          this.saving.set(false);
          this.form.reset({
            name: '',
            amount: null,
            categoryId: '',
          });
          this.submitted.set(false);
          this.reload();
        },
        error: () => {
          this.toast.error('Η προσθήκη απέτυχε.');
          this.saving.set(false);
        },
      });
  }

  protected remove(line: BudgetLineDto): void {
    this.budgetsApi.delete(line.id).subscribe({
      next: () => {
        this.toast.info('Η γραμμή διαγράφηκε.');
        this.reload();
      },
      error: () => this.toast.error('Η διαγραφή απέτυχε.'),
    });
  }

  private reload(): void {
    const buildingId = this.buildingId;
    if (!buildingId) return;
    this.loading.set(true);
    this.loadError.set(false);
    forkJoin([
      this.budgetsApi.list(buildingId, this.year()),
      this.budgetsApi.compare(buildingId, this.year()),
    ])
      .pipe(
        catchError(() => {
          this.loadError.set(true);
          this.loading.set(false);
          return EMPTY;
        }),
      )
      .subscribe(([lines, compare]) => {
        this.lines.set(lines);
        this.compare.set(compare);
        this.loading.set(false);
      });
  }
}
