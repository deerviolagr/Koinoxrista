import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
  ValidatorFn,
} from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService, RegistrationResult } from '../../core/auth.service';
import { AnalyticsService } from '../../core/analytics.service';
import { ReferralsApiService } from '../../core/api/referrals-api.service';
import { homeForRole } from '../../core/role.guard';
import { LocaleSelectorComponent } from '../../core/locale-selector.component';
import { TranslatePipe } from '../../core/translate.pipe';

/** Mirrors the API rule: at least one digit. */
export const containsDigit: ValidatorFn = (
  control: AbstractControl,
): ValidationErrors | null => {
  const value = String(control.value ?? '');
  return /\d/.test(value) ? null : { digit: true };
};

@Component({
  selector: 'app-register',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    TranslatePipe,
    LocaleSelectorComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mx-auto mt-10 w-full max-w-md px-4">
      <div class="card">
        <div class="mb-4 flex items-start justify-between gap-3">
          <h1 class="text-2xl font-bold text-slate-900">
            {{ 'register.title' | translate }}
          </h1>
          <app-locale-selector />
        </div>
        <p class="mb-6 text-sm text-slate-500">
          {{ 'register.intro' | translate }}
        </p>

        @if (inviteToken) {
          <div
            class="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800"
          >
            {{ 'register.inviteBanner' | translate }}
          </div>
        }

        @if (referralCode()) {
          <div
            class="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800"
          >
            {{ 'register.referralCode' | translate }}:
            <span class="font-semibold">{{ referralCode() }}</span>
            — {{ 'register.referralBannerBonus' | translate }}
          </div>
        }

        @if (errorMessage()) {
          <div
            class="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            role="alert"
          >
            {{ errorMessage() }}
          </div>
        }

        <form
          [formGroup]="form"
          (ngSubmit)="submit()"
          class="flex flex-col gap-4"
        >
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="label" for="firstName">
                {{ 'register.firstName' | translate }}
              </label>
              <input
                id="firstName"
                type="text"
                class="input"
                formControlName="firstName"
              />
              @if (submitted() && form.controls.firstName.invalid) {
                <p class="field-error">
                  {{ 'register.firstNameRequired' | translate }}
                </p>
              }
            </div>
            <div>
              <label class="label" for="lastName">
                {{ 'register.lastName' | translate }}
              </label>
              <input
                id="lastName"
                type="text"
                class="input"
                formControlName="lastName"
              />
              @if (submitted() && form.controls.lastName.invalid) {
                <p class="field-error">
                  {{ 'register.lastNameRequired' | translate }}
                </p>
              }
            </div>
          </div>
          <div>
            <label class="label" for="email">Email</label>
            <input
              id="email"
              type="email"
              class="input"
              formControlName="email"
            />
            @if (submitted() && form.controls.email.invalid) {
              <p class="field-error">
                {{ 'register.invalidEmail' | translate }}
              </p>
            }
          </div>
          <div>
            <label class="label" for="password">{{
              'register.password' | translate
            }}</label>
            <input
              id="password"
              type="password"
              class="input"
              autocomplete="new-password"
              formControlName="password"
            />
            @if (submitted() && form.controls.password.errors?.['required']) {
              <p class="field-error">
                {{ 'register.passwordRequired' | translate }}
              </p>
            }
            @if (submitted() && form.controls.password.errors?.['minlength']) {
              <p class="field-error">
                {{ 'register.passwordMinLength' | translate }}
              </p>
            }
            @if (submitted() && form.controls.password.errors?.['digit']) {
              <p class="field-error">
                {{ 'register.passwordDigit' | translate }}
              </p>
            }
          </div>

          @if (legacyRegistration) {
            <div>
              <label class="label" for="referralCode">
                {{ 'register.referralCodeLabel' | translate }}
              </label>
              <input
                id="referralCode"
                type="text"
                class="input uppercase"
                placeholder="BLD-XXXXXX"
                formControlName="referralCode"
              />
              <p class="mt-1 text-xs text-slate-500">
                {{ 'register.referralHint' | translate }}
              </p>
              @if (submitted() && form.controls.referralCode.invalid) {
                <p class="field-error">
                  {{ 'register.referralCodePattern' | translate }}
                </p>
              }
            </div>
          } @else {
            <div>
              <label class="label" for="buildingCode">Κωδικός κτιρίου</label>
              <input
                id="buildingCode"
                type="text"
                inputmode="text"
                minlength="8"
                maxlength="8"
                autocomplete="off"
                autocapitalize="characters"
                spellcheck="false"
                class="input font-mono uppercase tracking-widest"
                placeholder="ABC12345"
                formControlName="buildingCode"
                (input)="onBuildingCodeInput($event)"
              />
              <p class="mt-1 text-xs text-slate-500">
                Ο 8χαρακτήρων κωδικός που σας έδωσε ο διαχειριστή του κτιρίου.
              </p>
              @if (submitted() && form.controls.buildingCode.invalid) {
                <p class="field-error">
                  Δώστε ακριβώς 8 αλφαριθμητικούς χαρακτήρες.
                </p>
              }
            </div>
          }

          <button type="submit" class="btn btn-primary" [disabled]="loading()">
            {{
              loading()
                ? ('register.creating' | translate)
                : ('register.create' | translate)
            }}
          </button>
        </form>

        <p class="mt-4 text-sm text-slate-500">
          {{ 'register.hasAccount' | translate }}
          <a
            routerLink="/login"
            class="font-medium text-slate-900 hover:underline"
          >
            {{ 'register.loginLink' | translate }}
          </a>
        </p>
      </div>
    </div>
  `,
})
export class RegisterPage {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly analytics = inject(AnalyticsService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** Raw invite token from /register?invite=…; passed through to the API. */
  protected readonly inviteToken: string | null =
    this.route.snapshot.queryParamMap.get('invite');

  /** Referral code from /register?ref=BLD-XXXXXX; auto-prefilled. */
  protected readonly referralCode = signal<string>(
    (this.route.snapshot.queryParamMap.get('ref') ?? '').trim().toUpperCase(),
  );

  /** Invite/referral sign-up is a different, pre-approved account path. */
  protected readonly legacyRegistration =
    !!this.inviteToken || this.referralCode().length > 0;

  protected readonly submitted = signal(false);
  protected readonly loading = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    firstName: ['', [Validators.required]],
    lastName: ['', [Validators.required]],
    email: ['', [Validators.required, Validators.email]],
    password: [
      '',
      [
        Validators.required,
        Validators.minLength(8),
        Validators.maxLength(72),
        containsDigit,
      ],
    ],
    referralCode: [
      this.referralCode(),
      [Validators.pattern(/^[A-Za-z]{3}-[A-Za-z0-9]{6}$/)],
    ],
    buildingCode: [
      '',
      this.legacyRegistration
        ? []
        : [Validators.required, Validators.pattern(/^[A-Za-z0-9]{8}$/)],
    ],
  });

  protected onBuildingCodeInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const normalized = input.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    if (input.value !== normalized) input.value = normalized;
    this.form.controls.buildingCode.setValue(normalized);
  }

  protected submit(): void {
    this.submitted.set(true);
    this.errorMessage.set(null);
    if (this.form.invalid || this.loading()) return;
    this.loading.set(true);
    const { referralCode, buildingCode, ...identity } = this.form.getRawValue();
    const effectiveReferralCode = referralCode || this.referralCode();

    if (this.legacyRegistration) {
      this.registerLegacy(identity, effectiveReferralCode);
      return;
    }

    this.auth.registerOpen({ ...identity, buildingCode }).subscribe({
      next: (result) => this.onOpenRegistered(result),
      error: (error: unknown) => {
        this.errorMessage.set(this.registrationError(error));
        this.loading.set(false);
      },
    });
  }

  private registerLegacy(
    identity: {
      firstName: string;
      lastName: string;
      email: string;
      password: string;
    },
    referralCode: string,
  ): void {
    this.auth
      .register({
        ...identity,
        ...(referralCode ? { referralCode } : {}),
        ...(this.inviteToken ? { inviteToken: this.inviteToken } : {}),
      })
      .subscribe({
        next: () => {
          ReferralsApiService.stashPendingCode(referralCode);
          this.analytics.capture('register_completed');
          void this.router.navigateByUrl(homeForRole(this.auth.role));
        },
        error: (error: unknown) => {
          this.errorMessage.set(this.registrationError(error));
          this.loading.set(false);
        },
      });
  }

  private onOpenRegistered(result: RegistrationResult): void {
    this.analytics.capture('register_pending_verification', {
      status: result.status,
    });
    this.loading.set(false);
    void this.router.navigate(['/verify-email'], {
      queryParams: { email: result.email, pending: 1, status: result.status },
    });
  }

  private registrationError(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 400) {
        return 'Ο κωδικός κτιρίου δεν είναι έγκυρος.';
      }
      if (error.status === 409) {
        return 'Υπάρχει ήδη λογαριασμός με αυτό το email.';
      }
      if (error.status === 429) {
        return 'Έγιναν πολλές προσπάθειες. Δοκιμάστε ξανά αργότερα.';
      }
    }
    return 'Η εγγραφή απέτυχε. Ελέγξτε τα στοιχεία και δοκιμάστε ξανά.';
  }
}
