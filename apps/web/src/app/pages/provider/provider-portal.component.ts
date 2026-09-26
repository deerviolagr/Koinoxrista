import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { EMPTY, catchError, forkJoin, map, of } from 'rxjs';
import {
  CreateWorkLogDto,
  JobStatus,
  MyPayoutDto,
  WorkLogView,
} from '@org/shared';
import {
  ProviderBidView,
  ProviderMarketJob,
  ProviderMineJob,
  JobsApiService,
  ProviderProfile,
  ProviderProfileApiService,
  jobStatusBadge,
} from '../../core/api/jobs-api.service';
import {
  PayoutsApiService,
  supplierPaymentMethodLabel,
} from '../../core/api/payouts-api.service';
import { MoneyPipe } from '../../ui/money.pipe';
import { ToastService } from '../../ui/toast.service';
import { eurosToCents } from '../../ui/format';
import { HelpTourComponent, HelpTourStep } from '../../ui/help-tour.component';
import { TourService } from '../../core/tour.service';

type ProviderTab = 'MARKET' | 'MINE' | 'PROFILE';
type ProviderPayout = MyPayoutDto & { currency?: string };
type ProviderMineGroup = {
  status: JobStatus;
  label: string;
  jobs: ProviderMineJob[];
};

/** Finds the current provider's submitted bid in a stable marketplace row. */
export function findOwnActiveBid(
  job: Pick<ProviderMarketJob, 'bids'>,
  userId?: string | null,
): ProviderBidView | null {
  return (
    job.bids.find(
      (bid) =>
        bid.status === 'SUBMITTED' &&
        (!userId || bid.providerUserId === userId),
    ) ?? null
  );
}

/** Splits a comma-separated cert string into clean chips (pure). */
export function parseCerts(value: string): string[] {
  return value
    .split(',')
    .map((cert) => cert.trim())
    .filter(Boolean);
}

@Component({
  selector: 'app-provider-portal',
  imports: [ReactiveFormsModule, HelpTourComponent, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-6 flex flex-wrap gap-2">
      <button
        type="button"
        class="btn !px-3 !py-1 text-xs"
        [class.btn-primary]="tab() === 'MARKET'"
        [class.btn-secondary]="tab() !== 'MARKET'"
        (click)="tab.set('MARKET')"
      >
        Αγορά
      </button>
      <button
        type="button"
        class="btn !px-3 !py-1 text-xs"
        [class.btn-primary]="tab() === 'MINE'"
        [class.btn-secondary]="tab() !== 'MINE'"
        (click)="tab.set('MINE')"
      >
        Οι εργασίες μου
      </button>
      <button
        type="button"
        class="btn !px-3 !py-1 text-xs"
        [class.btn-primary]="tab() === 'PROFILE'"
        [class.btn-secondary]="tab() !== 'PROFILE'"
        (click)="tab.set('PROFILE')"
      >
        Προφίλ
      </button>
    </div>

    @switch (tab()) {
      @case ('MARKET') {
        <h1 class="mb-4 text-xl font-bold text-slate-900">Αγορά εργασιών</h1>
        @if (loading()) {
          <div class="card text-sm text-slate-500">Φόρτωση…</div>
        } @else if (loadError()) {
          <div class="card border-red-200 bg-red-50 text-sm text-red-700">
            Αποτυχία φόρτωσης της αγοράς.
          </div>
        } @else if (marketJobs().length === 0) {
          <div class="card text-sm text-slate-500">
            Δεν υπάρχουν ανοιχτές εργασίες προς προσφορά αυτή τη στιγμή.
          </div>
        }
        <div class="flex flex-col gap-4">
          @for (job of marketJobs(); track job.id) {
            <div class="card">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <h2 class="font-semibold text-slate-900">{{ job.title }}</h2>
                  <p class="text-xs text-slate-500">{{ job.buildingName }}</p>
                </div>
                @if (
                  job.budgetCents !== null && job.budgetCents !== undefined
                ) {
                  <span class="badge bg-slate-200 text-slate-700">
                    Έως {{ job.budgetCents | money: job.currency }}
                  </span>
                }
              </div>
              <p class="mt-1 text-sm text-slate-600">{{ job.description }}</p>

              @if (ownBid(job); as bid) {
                <div
                  class="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3"
                >
                  <p class="mb-2 text-xs font-semibold text-blue-800">
                    Η προσφορά σας (υπό εξέταση)
                  </p>
                  <div class="flex flex-wrap items-end gap-2">
                    <div>
                      <label
                        class="label !mb-1 text-xs"
                        [for]="'amount-' + job.id"
                      >
                        Ποσό
                      </label>
                      <input
                        [id]="'amount-' + job.id"
                        type="number"
                        min="0"
                        step="0.01"
                        class="input !w-32"
                        [value]="editAmount(job.id, bid)"
                        (input)="onEditAmount(job.id, $event)"
                      />
                    </div>
                    <div class="min-w-48 grow">
                      <label class="label !mb-1 text-xs" [for]="'msg-' + job.id"
                        >Μήνυμα</label
                      >
                      <input
                        [id]="'msg-' + job.id"
                        type="text"
                        class="input"
                        [value]="editMessage(job.id, bid)"
                        (input)="onEditMessage(job.id, $event)"
                      />
                    </div>
                    <button
                      type="button"
                      class="btn btn-primary !px-3 !py-1 text-xs"
                      [disabled]="saving()"
                      (click)="updateBid(job.id)"
                    >
                      Ενημέρωση προσφοράς
                    </button>
                  </div>
                  <p class="mt-2 text-xs text-slate-500">
                    Τρέχουσα προσφορά:
                    {{ bid.amountCents | money: job.currency }}
                  </p>
                </div>
              } @else {
                <button
                  type="button"
                  class="btn btn-primary mt-3 !px-3 !py-1 text-xs"
                  (click)="openBidModal(job)"
                >
                  Υποβολή προσφοράς
                </button>
              }
            </div>
          }
        </div>
      }
      @case ('MINE') {
        <h1 class="mb-4 text-xl font-bold text-slate-900">Οι εργασίες μου</h1>
        @if (loading()) {
          <div class="card text-sm text-slate-500">Φόρτωση…</div>
        } @else if (loadError()) {
          <div class="card border-red-200 bg-red-50 text-sm text-red-700">
            Αποτυχία φόρτωσης των εργασιών σας.
          </div>
        } @else if (mineGroups().length === 0) {
          <div class="card text-sm text-slate-500">
            Δεν έχετε υποβάλει προσφορές.
          </div>
        }
        <div class="flex flex-col gap-6">
          @for (group of mineGroups(); track group.status) {
            <section>
              <h2 class="card-title">{{ group.label }}</h2>
              <div class="flex flex-col gap-4">
                @for (entry of group.jobs; track entry.id) {
                  <div class="card">
                    <div class="flex items-start justify-between gap-2">
                      <div>
                        <h3 class="font-semibold text-slate-900">
                          {{ entry.title }}
                        </h3>
                        <p class="text-xs text-slate-500">
                          {{ entry.buildingName }}
                        </p>
                      </div>
                      <span
                        class="badge shrink-0"
                        [class]="jobStatusBadge(group.status).cls"
                      >
                        {{ jobStatusBadge(group.status).label }}
                      </span>
                    </div>
                    @if (entry.description) {
                      <p class="mt-1 text-sm text-slate-600">
                        {{ entry.description }}
                      </p>
                    }
                    <p class="mt-2 text-sm font-medium text-slate-700">
                      Προσφορά:
                      {{ entry.bid.amountCents | money: entry.currency }}
                    </p>

                    @if (
                      group.status === 'AWARDED' ||
                      group.status === 'IN_PROGRESS'
                    ) {
                      <div class="mt-3 grid gap-3 md:grid-cols-2">
                        <div>
                          <label
                            class="label !mb-1 text-xs"
                            [for]="'log-' + entry.id"
                          >
                            Νέα καταγραφή εργασίας
                          </label>
                          <textarea
                            [id]="'log-' + entry.id"
                            rows="2"
                            class="input"
                            [value]="noteFor(entry.id) ?? ''"
                            (input)="onNoteInput(entry.id, $event)"
                          ></textarea>
                          <button
                            type="button"
                            class="btn btn-primary mt-2 !px-3 !py-1 text-xs"
                            [disabled]="saving()"
                            (click)="addWorkLog(entry.id)"
                          >
                            Καταγραφή
                          </button>
                        </div>
                        <div>
                          <p
                            class="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500"
                          >
                            Ημερολόγιο
                          </p>
                          @if (logsOf(entry.id); as logs) {
                            <ol
                              class="flex max-h-48 flex-col gap-2 overflow-y-auto border-l-2 border-slate-200 pl-4"
                            >
                              @for (log of logs; track log.id) {
                                <li class="relative text-sm">
                                  <span
                                    class="absolute top-1.5 -left-[21px] h-3 w-3 rounded-full border-2 border-white bg-slate-400"
                                  ></span>
                                  <p>{{ log.note }}</p>
                                  <p class="text-xs text-slate-500">
                                    {{ when(log.loggedAt) }}
                                  </p>
                                </li>
                              }
                            </ol>
                          } @else {
                            <p class="text-xs text-slate-500">
                              Καμία καταγραφή ακόμη.
                            </p>
                          }
                        </div>
                      </div>
                    }
                  </div>
                }
              </div>
            </section>
          }
        </div>
      }
      @case ('PROFILE') {
        <h1 class="mb-4 text-xl font-bold text-slate-900">Προφίλ</h1>
        <div class="card max-w-xl">
          @if (profileLoadError()) {
            <p class="text-sm text-red-700">Αποτυχία φόρτωσης του προφίλ.</p>
          } @else if (profileLoading()) {
            <p class="text-sm text-slate-500">Φόρτωση…</p>
          } @else {
            @if (profile(); as p) {
              @if (p.rating !== null && p.rating !== undefined) {
                <p class="mb-4 text-sm">
                  <span class="text-amber-500">
                    @for (star of starRange(5); track star) {
                      <span>{{
                        star <= roundedStars(p.rating!) ? '★' : '☆'
                      }}</span>
                    }
                  </span>
                  {{ p.rating }} / 5
                </p>
              }
            } @else {
              <p class="mb-4 text-sm text-slate-500">
                Δεν έχει δημιουργηθεί προφίλ ακόμη. Συμπληρώστε το παρακάτω και
                αποθηκεύστε.
              </p>
            }
            <form
              [formGroup]="profileForm"
              (ngSubmit)="saveProfile()"
              class="flex flex-col gap-4"
            >
              <div>
                <label class="label" for="trade">Ειδικότητα</label>
                <input
                  id="trade"
                  type="text"
                  class="input"
                  formControlName="trade"
                />
                @if (
                  profileForm.controls.trade.invalid &&
                  profileForm.controls.trade.touched
                ) {
                  <p class="field-error">Δώστε την ειδικότητά σας.</p>
                }
              </div>
              <div>
                <label class="label" for="certs"
                  >Πιστοποιητικά (διαχωρισμένα με κόμμα)</label
                >
                <input
                  id="certs"
                  type="text"
                  class="input"
                  formControlName="certs"
                />
                @if (certChips().length) {
                  <div class="mt-2 flex flex-wrap gap-1">
                    @for (chip of certChips(); track chip) {
                      <span class="badge bg-slate-200 text-slate-700">{{
                        chip
                      }}</span>
                    }
                  </div>
                }
              </div>
              <button
                type="submit"
                class="btn btn-primary self-start"
                [disabled]="saving()"
              >
                {{ profile() ? 'Αποθήκευση' : 'Δημιουργία προφίλ' }}
              </button>
            </form>
          }
        </div>
      }
    }

    <section class="mt-8" aria-label="Πληρωμές">
      <h2 class="mb-3 text-lg font-bold text-slate-900">Πληρωμές</h2>
      @if (payoutsLoading()) {
        <div class="card text-sm text-slate-500">Φόρτωση πληρωμών…</div>
      } @else if (payouts().length === 0) {
        <div class="card text-sm text-slate-500">
          Δεν υπάρχουν πληρωμές για τις εργασίες σας ακόμη.
        </div>
      } @else {
        <div class="card overflow-x-auto p-0">
          <table class="data-table">
            <thead>
              <tr>
                <th>Ημερομηνία</th>
                <th>Εργασία</th>
                <th>Μέθοδος</th>
                <th>Ποσό</th>
              </tr>
            </thead>
            <tbody>
              @for (payout of payouts(); track payout.id) {
                <tr>
                  <td>{{ when(payout.paidAt) }}</td>
                  <td class="font-medium">{{ payout.jobTitle }}</td>
                  <td>{{ methodLabel(payout.method) }}</td>
                  <td class="font-medium">
                    {{ payout.amountCents | money: payout.currency }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>

    @if (bidModalJob(); as job) {
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <button
          type="button"
          class="absolute inset-0 cursor-default bg-slate-900/40"
          (click)="bidModalJob.set(null)"
          aria-label="Κλείσιμο"
        ></button>

        <div class="card relative z-10 w-full max-w-md">
          <h2 class="mb-1 text-base font-semibold text-slate-900">
            Προσφορά για «{{ job.title }}»
          </h2>
          <p class="mb-3 text-xs text-slate-500">{{ job.buildingName }}</p>
          <form (ngSubmit)="submitBid()" class="flex flex-col gap-4">
            <div>
              <label class="label" for="bidAmount">Ποσό</label>
              <input
                id="bidAmount"
                type="number"
                min="0"
                step="0.01"
                class="input"
                [formControl]="bidAmountCtrl"
              />
              @if (bidSubmitted() && bidAmountCtrl.invalid) {
                <p class="field-error">
                  Δώστε έγκυρο ποσό μεγαλύτερο του μηδενός.
                </p>
              }
            </div>
            <div>
              <label class="label" for="bidMessage">Μήνυμα (προαιρετικό)</label>
              <textarea
                id="bidMessage"
                rows="2"
                class="input"
                [formControl]="bidMessageCtrl"
              ></textarea>
            </div>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="bidModalJob.set(null)"
              >
                Άκυρο
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                [disabled]="saving()"
              >
                Υποβολή
              </button>
            </div>
          </form>
        </div>
      </div>
    }

    @if (showTour()) {
      <app-help-tour
        tourId="provider-portal"
        [steps]="tourSteps"
        (closed)="showTour.set(false)"
      />
    }
  `,
})
export class ProviderPortalPage implements OnInit {
  private readonly jobsApi = inject(JobsApiService);
  private readonly profileApi = inject(ProviderProfileApiService);
  private readonly payoutsApi = inject(PayoutsApiService);
  private readonly toast = inject(ToastService);
  private readonly fb = inject(FormBuilder);
  private readonly tour = inject(TourService);

  protected readonly jobStatusBadge = jobStatusBadge;
  protected readonly methodLabel = supplierPaymentMethodLabel;

  protected readonly showTour = signal(this.tour.launch('provider-portal'));
  protected readonly tourSteps: HelpTourStep[] = [
    {
      title: 'Καλώς ήρθατε στην Αγορά!',
      body: 'Βρείτε εργασίες συντήρησης και υποβάλετε τις προσφορές σας.',
      selector: 'h1',
    },
    {
      title: 'Οι καρτέλες σας',
      body: '«Αγορά», «Οι εργασίες μου» και «Προφίλ» — Όλα σε ένα μέρος.',
    },
  ];

  protected readonly payouts = signal<ProviderPayout[]>([]);
  protected readonly tab = signal<ProviderTab>('MARKET');
  protected readonly marketJobs = signal<ProviderMarketJob[]>([]);
  protected readonly mineJobs = signal<ProviderMineJob[]>([]);
  protected readonly workLogs = signal<Record<string, WorkLogView[]>>({});
  protected readonly workLogNotes = signal<Record<string, string>>({});
  protected readonly editAmounts = signal<Record<string, string>>({});
  protected readonly editMessages = signal<Record<string, string>>({});
  protected readonly profile = signal<ProviderProfile | null>(null);

  protected readonly bidModalJob = signal<ProviderMarketJob | null>(null);
  protected readonly bidAmountCtrl = this.fb.control<number | null>(null, [
    Validators.required,
    Validators.min(0.01),
  ]);
  protected readonly bidMessageCtrl = this.fb.nonNullable.control('');
  protected readonly bidSubmitted = signal(false);

  protected readonly profileForm = this.fb.nonNullable.group({
    trade: ['', [Validators.required, Validators.maxLength(100)]],
    certs: [''],
  });

  protected readonly saving = signal(false);
  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly profileLoading = signal(true);
  protected readonly profileLoadError = signal(false);
  protected readonly payoutsLoading = signal(true);

  protected certChips(): string[] {
    return parseCerts(this.profileForm.controls.certs.value);
  }

  ngOnInit(): void {
    this.reloadJobs();
    this.loadPayouts();
    this.profileApi
      .get()
      .pipe(
        catchError(() => {
          this.profileError();
          return of(null);
        }),
      )
      .subscribe((profile) => {
        this.profile.set(profile);
        this.profileForm.reset({
          trade: profile?.trade ?? '',
          certs: profile?.certs.join(', ') ?? '',
        });
        this.profileLoading.set(false);
      });
  }

  protected readonly mineGroups = computed<ProviderMineGroup[]>(() => {
    const groups: ProviderMineGroup[] = [
      { status: 'AWARDED', label: 'Ανατεθειμένες', jobs: [] },
      { status: 'IN_PROGRESS', label: 'Σε εξέλιξη', jobs: [] },
      { status: 'COMPLETED', label: 'Ολοκληρωμένες', jobs: [] },
    ];
    for (const entry of this.mineJobs()) {
      const group = groups.find(
        (candidate) => candidate.status === entry.status,
      );
      if (group) group.jobs.push(entry);
    }
    return groups.filter((group) => group.jobs.length > 0);
  });

  protected ownBid(job: ProviderMarketJob): ProviderBidView | null {
    return findOwnActiveBid(job);
  }

  protected logsOf(jobId: string): WorkLogView[] | null {
    const logs = this.workLogs()[jobId];
    return logs && logs.length > 0 ? logs : null;
  }

  protected editAmount(jobId: string, bid: ProviderBidView): string {
    return this.editAmounts()[jobId] ?? (bid.amountCents / 100).toFixed(2);
  }

  protected editMessage(jobId: string, bid: ProviderBidView): string {
    return this.editMessages()[jobId] ?? bid.message ?? '';
  }

  protected noteFor(jobId: string): string | undefined {
    return this.workLogNotes()[jobId];
  }

  protected openBidModal(job: ProviderMarketJob): void {
    this.bidSubmitted.set(false);
    this.bidAmountCtrl.reset(null);
    this.bidMessageCtrl.reset('');
    this.bidModalJob.set(job);
  }

  protected submitBid(): void {
    const job = this.bidModalJob();
    this.bidSubmitted.set(true);
    if (!job || this.bidAmountCtrl.invalid || this.saving()) return;
    const cents = eurosToCents(this.bidAmountCtrl.value ?? NaN);
    if (!Number.isFinite(cents) || cents <= 0) return;
    this.saving.set(true);
    this.jobsApi
      .createBid(job.id, {
        amountCents: cents,
        message: this.bidMessageCtrl.value.trim() || undefined,
      })
      .pipe(
        catchError(() => {
          this.toast.error('Η υποβολή της προσφοράς απέτυχε.');
          this.saving.set(false);
          return EMPTY;
        }),
      )
      .subscribe(() => {
        this.toast.success('Η προσφορά υποβλήθηκε.');
        this.saving.set(false);
        this.bidModalJob.set(null);
        this.reloadJobs();
      });
  }

  protected onEditAmount(jobId: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.editAmounts.update((drafts) => ({ ...drafts, [jobId]: value }));
  }

  protected onEditMessage(jobId: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.editMessages.update((drafts) => ({ ...drafts, [jobId]: value }));
  }

  protected updateBid(jobId: string): void {
    const currentJob = this.marketJobs().find((job) => job.id === jobId);
    const currentBid = currentJob ? this.ownBid(currentJob) : null;
    const raw =
      this.editAmounts()[jobId] ??
      (currentBid ? (currentBid.amountCents / 100).toFixed(2) : '');
    const cents = eurosToCents(raw);
    if (!Number.isFinite(cents) || cents <= 0) {
      this.toast.error('Δώστε έγκυρο ποσό.');
      return;
    }
    if (this.saving()) return;
    this.saving.set(true);
    this.jobsApi
      .createBid(jobId, {
        amountCents: cents,
        message: this.editMessages()[jobId]?.trim() || undefined,
      })
      .pipe(
        catchError(() => {
          this.toast.error('Η ενημέρωση απέτυχε.');
          this.saving.set(false);
          return EMPTY;
        }),
      )
      .subscribe(() => {
        this.toast.success('Η προσφορά ενημερώθηκε.');
        this.saving.set(false);
        this.reloadJobs();
      });
  }

  protected onNoteInput(jobId: string, event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.workLogNotes.update((drafts) => ({ ...drafts, [jobId]: value }));
  }

  protected addWorkLog(jobId: string): void {
    const note = (this.workLogNotes()[jobId] ?? '').trim();
    if (!note || this.saving()) return;
    const dto: CreateWorkLogDto = { note };
    this.saving.set(true);
    this.jobsApi
      .addWorkLog(jobId, dto)
      .pipe(
        catchError(() => {
          this.toast.error('Η καταγραφή απέτυχε.');
          this.saving.set(false);
          return EMPTY;
        }),
      )
      .subscribe((log) => {
        this.toast.success('Η καταγραφή αποθηκεύτηκε.');
        this.saving.set(false);
        this.workLogNotes.update((drafts) => ({ ...drafts, [jobId]: '' }));
        this.workLogs.update((current) => ({
          ...current,
          [jobId]: [...(current[jobId] ?? []), log],
        }));
      });
  }

  protected saveProfile(): void {
    if (this.saving() || this.profileForm.invalid) {
      this.profileForm.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    const { trade, certs } = this.profileForm.getRawValue();
    this.profileApi
      .update({ trade: trade.trim(), certs: parseCerts(certs) })
      .pipe(
        catchError(() => {
          this.toast.error('Η αποθήκευση απέτυχε.');
          this.saving.set(false);
          return EMPTY;
        }),
      )
      .subscribe((profile) => {
        this.toast.success(
          this.profile()
            ? 'Το προφίλ αποθηκεύτηκε.'
            : 'Το προφίλ δημιουργήθηκε.',
        );
        this.profile.set(profile);
        this.saving.set(false);
      });
  }

  protected starRange(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i + 1);
  }

  protected roundedStars(value: number): number {
    return Math.round(value);
  }

  protected when(iso: string | undefined): string {
    return iso
      ? new Date(iso).toLocaleString('el-GR', {
          dateStyle: 'short',
          timeStyle: 'short',
        })
      : '';
  }

  private reloadJobs(): void {
    this.loading.set(true);
    this.loadError.set(false);
    forkJoin({
      market: this.jobsApi.marketplace().pipe(
        catchError(() => {
          this.loadError.set(true);
          return of<ProviderMarketJob[]>([]);
        }),
      ),
      mine: this.jobsApi.mine().pipe(
        catchError(() => {
          this.loadError.set(true);
          return of<ProviderMineJob[]>([]);
        }),
      ),
    }).subscribe(({ market, mine }) => {
      this.marketJobs.set(market);
      this.mineJobs.set(mine);
      this.loading.set(false);
      this.loadMineWorkLogs();
    });
  }

  private loadMineWorkLogs(): void {
    const targets = this.mineJobs().filter(
      (entry) => entry.status === 'AWARDED' || entry.status === 'IN_PROGRESS',
    );
    if (!targets.length) return;
    forkJoin(
      targets.map((entry) =>
        this.jobsApi.workLogs(entry.id).pipe(
          catchError(() => of<WorkLogView[]>([])),
          map((logs) => [entry.id, logs] as const),
        ),
      ),
    ).subscribe((pairs) => {
      this.workLogs.update((current) => ({
        ...current,
        ...Object.fromEntries(pairs),
      }));
    });
  }

  private loadPayouts(): void {
    this.payoutsApi
      .mine()
      .pipe(
        catchError(() => {
          this.payouts.set([]);
          return of<ProviderPayout[]>([]);
        }),
      )
      .subscribe((payouts) => {
        this.payouts.set(payouts);
        this.payoutsLoading.set(false);
      });
  }

  private profileError(): void {
    this.profileLoadError.set(true);
  }
}
