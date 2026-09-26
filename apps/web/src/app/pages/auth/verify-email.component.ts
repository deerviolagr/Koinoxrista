import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AccountStatus, AuthService } from '../../core/auth.service';
import { LocaleSelectorComponent } from '../../core/locale-selector.component';

const ACCOUNT_STATUSES: readonly AccountStatus[] = [
  'ACTIVE',
  'PENDING_VERIFICATION',
  'PENDING_APPROVAL',
  'REJECTED',
  'SUSPENDED',
];

function isAccountStatus(value: string | null): value is AccountStatus {
  return !!value && ACCOUNT_STATUSES.includes(value as AccountStatus);
}

@Component({
  selector: 'app-verify-email',
  imports: [ReactiveFormsModule, RouterLink, LocaleSelectorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mx-auto mt-10 w-full max-w-md px-4">
      <div class="card">
        <div class="mb-5 flex items-start justify-between gap-3">
          <h1 class="text-2xl font-bold text-slate-900">Επιβεβαίωση email</h1>
          <app-locale-selector />
        </div>

        @if (verifying()) {
          <div class="py-6 text-center text-sm text-slate-500" role="status">
            Επιβεβαιώνουμε τον σύνδεσμο…
          </div>
        } @else if (status() === 'ACTIVE') {
          <div
            class="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"
          >
            <h2 class="font-semibold">Το email επιβεβαιώθηκε</h2>
            <p class="mt-1">
              Ο λογαριασμός σας ενεργοποιήθηκε. Μπορείτε να συνδεθείτε.
            </p>
            <a routerLink="/login" class="btn btn-primary mt-4">Σύνδεση</a>
          </div>
        } @else if (status() === 'PENDING_APPROVAL') {
          <div
            class="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
          >
            <h2 class="font-semibold">Αναμονή έγκρισης</h2>
            <p class="mt-1">
              Το email επιβεβαιώθηκε. Ο διαχειριστής πρέπει να εγκρίνει τη
              σύνδεσή σας με το κτίριο πριν μπορέσετε να δείτε τα δεδομένα του.
            </p>
            <a routerLink="/login" class="btn btn-secondary mt-4"
              >Επιστροφή στη σύνδεση</a
            >
          </div>
        } @else if (status() === 'INVALID' || status() === 'EXPIRED') {
          <div
            class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
          >
            <h2 class="font-semibold">
              {{
                status() === 'EXPIRED'
                  ? 'Ο σύνδεσμος έληξε'
                  : 'Μη έγκυρος σύνδεσμος'
              }}
            </h2>
            <p class="mt-1">
              Ζητήστε νέο email επιβεβαίωσης χρησιμοποιώντας το παρακάτω email.
            </p>
          </div>
        } @else {
          <div
            class="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800"
          >
            <h2 class="font-semibold">Ελέγξτε το email σας</h2>
            <p class="mt-1">
              Στείλαμε σύνδεσμο επιβεβαίωσης. Ανοίξτε τον σύνδεσμο για να
              ολοκληρώσετε την εγγραφή.
            </p>
          </div>
        }

        @if (resendMessage()) {
          <p
            class="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
            role="status"
          >
            {{ resendMessage() }}
          </p>
        }

        @if (status() !== 'ACTIVE' && status() !== 'PENDING_APPROVAL') {
          <form
            [formGroup]="resendForm"
            (ngSubmit)="resend()"
            class="mt-5 flex flex-col gap-3 border-t border-slate-200 pt-5"
          >
            <div>
              <label class="label" for="resendEmail">Email λογαριασμού</label>
              <input
                id="resendEmail"
                type="email"
                autocomplete="email"
                class="input"
                formControlName="email"
              />
              @if (resendSubmitted() && resendForm.controls.email.invalid) {
                <p class="field-error">Δώστε έγκυρο email.</p>
              }
            </div>
            <button
              type="submit"
              class="btn btn-secondary self-start"
              [disabled]="resending()"
            >
              {{
                resending() ? 'Αποστολή…' : 'Επαναποστολή email επιβεβαίωσης'
              }}
            </button>
          </form>
        }

        <a
          routerLink="/login"
          class="mt-5 inline-block text-sm text-slate-600 underline"
        >
          Επιστροφή στη σύνδεση
        </a>
      </div>
    </div>
  `,
})
export class VerifyEmailPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly fb = inject(FormBuilder);

  protected readonly verifying = signal(false);
  protected readonly resending = signal(false);
  protected readonly resendSubmitted = signal(false);
  protected readonly resendMessage = signal<string | null>(null);
  protected readonly status = signal<
    AccountStatus | 'INVALID' | 'EXPIRED' | null
  >(null);

  protected readonly resendForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  ngOnInit(): void {
    const query = this.route.snapshot.queryParamMap;
    const email = (query.get('email') ?? this.stashedEmail() ?? '').trim();
    if (email) this.resendForm.controls.email.setValue(email);
    const queryStatus = query.get('status');
    if (isAccountStatus(queryStatus)) this.status.set(queryStatus);

    const token = query.get('token')?.trim();
    if (token) this.verify(token);
  }

  protected verify(token: string): void {
    if (this.verifying()) return;
    this.verifying.set(true);
    this.status.set(null);
    this.auth.verifyEmail(token).subscribe({
      next: (result) => {
        this.status.set(result.status);
        this.verifying.set(false);
        if (result.email) {
          this.resendForm.controls.email.setValue(result.email);
          this.stashEmail(result.email);
        }
      },
      error: (error: unknown) => {
        this.status.set(
          error instanceof HttpErrorResponse && error.status === 410
            ? 'EXPIRED'
            : 'INVALID',
        );
        this.verifying.set(false);
      },
    });
  }

  protected resend(): void {
    this.resendSubmitted.set(true);
    this.resendMessage.set(null);
    if (this.resendForm.invalid || this.resending()) return;
    const email = this.resendForm.getRawValue().email.trim().toLowerCase();
    this.resending.set(true);
    this.auth.resendVerification(email).subscribe({
      next: () => {
        this.resending.set(false);
        this.resendMessage.set(
          'Αν χρειάζεται επιβεβαίωση, στείλαμε νέο email. Ελέγξτε και τα junk.',
        );
        this.stashEmail(email);
      },
      error: () => {
        this.resending.set(false);
        this.resendMessage.set(
          'Δεν ήταν δυνατή η επαναποστολή. Ζορίστε το email και δοκιμάστε ξανά.',
        );
      },
    });
  }

  private stashEmail(email: string): void {
    try {
      sessionStorage.setItem('pending-registration-email', email);
    } catch {
      // Storage can be unavailable in privacy mode; the field still works.
    }
  }

  private stashedEmail(): string | null {
    try {
      return sessionStorage.getItem('pending-registration-email');
    } catch {
      return null;
    }
  }
}
