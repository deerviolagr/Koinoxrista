import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { homeForRole } from '../../core/role.guard';
import { TranslatePipe } from '../../core/translate.pipe';

/** One-click demo accounts, one per role (seeded by apps/api/prisma/seed.ts). */
const DEMO_ACCOUNTS = [
  { email: 'admin@demo.gr', password: 'Admin1234!', roleKey: 'role.admin' },
  {
    email: 'owner@demo.gr',
    password: 'Owner1234!',
    roleKey: 'role.buildingOwner',
  },
  {
    email: 'accountant@demo.gr',
    password: 'Accountant123!',
    roleKey: 'role.accountant',
  },
  {
    email: 'platform@demo.gr',
    password: 'Platform1234!',
    roleKey: 'role.platformAdmin',
  },
  { email: 'maria@demo.gr', password: 'Password123!', roleKey: 'role.resident' },
  { email: 'provider@demo.gr', password: 'Password123!', roleKey: 'role.provider' },
] as const;

type DemoAccount = (typeof DEMO_ACCOUNTS)[number];

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mx-auto mt-10 w-full max-w-md px-4">
      <div class="card">
        <h1 class="mb-1 text-2xl font-bold text-slate-900">{{ 'login.title' | translate }}</h1>

        @if (ticket()) {
          <!-- ΒΗΜΑ 2: κωδικός επαλήθευσης (2FA) -->
          <p class="mb-6 text-sm text-slate-500">
            {{ 'login.twoFactorIntro' | translate }}
          </p>

          @if (errorKey()) {
            <div
              class="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {{ errorKey() | translate }}
            </div>
          }

          <form
            [formGroup]="codeForm"
            (ngSubmit)="submitCode()"
            class="flex flex-col gap-4"
          >
            <div>
              <label class="label" for="code">{{ 'login.verificationCode' | translate }}</label>
              <input
                id="code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                class="input font-mono tracking-widest"
                formControlName="code"
                placeholder="123456"
              />
            </div>
            <button type="submit" class="btn btn-primary" [disabled]="loading()">
              {{ loading() ? ('login.verifying' | translate) : ('login.verify' | translate) }}
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="loading()"
              (click)="cancelTwoFactor()"
            >
              {{ 'login.backToLogin' | translate }}
            </button>
          </form>
        } @else {
          <!-- ΒΗΜΑ 1: email + κωδικός -->
          <p class="mb-6 text-sm text-slate-500">
            {{ 'login.intro' | translate }}
          </p>

          @if (errorKey()) {
            <div
              class="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {{ errorKey() | translate }}
            </div>
          }

          <form
            [formGroup]="form"
            (ngSubmit)="submit()"
            class="flex flex-col gap-4"
          >
            <div>
              <label class="label" for="email">Email</label>
              <input
                id="email"
                type="email"
                class="input"
                formControlName="email"
              />
              @if (submitted() && form.controls.email.invalid) {
                <p class="field-error">{{ 'login.invalidEmail' | translate }}</p>
              }
            </div>
            <div>
              <label class="label" for="password">{{ 'login.password' | translate }}</label>
              <input
                id="password"
                type="password"
                class="input"
                formControlName="password"
              />
              @if (submitted() && form.controls.password.invalid) {
                <p class="field-error">{{ 'login.passwordRequired' | translate }}</p>
              }
            </div>
            <button
              type="submit"
              class="btn btn-primary"
              [disabled]="loading()"
            >
              {{ loading() ? ('login.connecting' | translate) : ('login.submit' | translate) }}
            </button>
          </form>

          <p class="mt-4 text-sm text-slate-500">
            {{ 'login.noAccount' | translate }}
            <a
              routerLink="/register"
              class="font-medium text-slate-900 hover:underline"
            >
              {{ 'login.register' | translate }}
            </a>
          </p>
        }
      </div>

      @if (!ticket()) {
        <div
          class="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-4 text-sm text-slate-600"
        >
          <p class="font-semibold">{{ 'login.demoAccounts' | translate }}</p>
          <div class="mt-2 grid gap-2">
            @for (account of demoAccounts; track account.email) {
              <button
                type="button"
                class="btn btn-secondary flex items-center justify-between gap-2"
                [attr.data-demo-email]="account.email"
                [disabled]="loading()"
                (click)="loginAs(account)"
              >
                <span class="font-medium">{{ account.roleKey | translate }}</span>
                <span class="font-mono text-xs text-slate-500">{{ account.email }}</span>
              </button>
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class LoginPage {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly submitted = signal(false);
  protected readonly loading = signal(false);
  protected readonly errorKey = signal<string | null>(null);
  /** Set when POST /auth/login answers {twoFactorRequired, ticket}. */
  protected readonly ticket = signal<string | null>(null);

  protected readonly demoAccounts = DEMO_ACCOUNTS;

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  protected readonly codeForm = this.fb.nonNullable.group({
    code: ['', [Validators.required, Validators.minLength(6)]],
  });

  protected submit(): void {
    this.submitted.set(true);
    this.errorKey.set(null);
    if (this.form.invalid || this.loading()) return;
    this.loading.set(true);
    const { email, password } = this.form.getRawValue();
    this.auth.login(email, password).subscribe({
      next: (step) => {
        if (step.status === 'two-factor') {
          this.ticket.set(step.ticket);
          this.loading.set(false);
          return;
        }
        void this.router.navigateByUrl(homeForRole(this.auth.role));
      },
      error: () => {
        this.errorKey.set('login.errorBadCredentials');
        this.loading.set(false);
      },
    });
  }

  /** One-click sign in with a seeded demo account. */
  protected loginAs(account: DemoAccount): void {
    if (this.loading()) return;
    this.errorKey.set(null);
    this.submitted.set(true);
    this.form.setValue({ email: account.email, password: account.password });
    this.loading.set(true);
    this.auth.login(account.email, account.password).subscribe({
      next: (step) => {
        if (step.status === 'two-factor') {
          this.ticket.set(step.ticket);
          this.loading.set(false);
          return;
        }
        void this.router.navigateByUrl(homeForRole(this.auth.role));
      },
      error: () => {
        this.errorKey.set('login.errorBadCredentials');
        this.loading.set(false);
      },
    });
  }

  protected submitCode(): void {
    this.errorKey.set(null);
    const ticket = this.ticket();
    if (!ticket || this.codeForm.invalid || this.loading()) return;
    this.loading.set(true);
    const { code } = this.codeForm.getRawValue();
    this.auth.loginWith2fa(ticket, code.trim()).subscribe({
      next: () => void this.router.navigateByUrl(homeForRole(this.auth.role)),
      error: () => {
        this.errorKey.set('login.errorBadCode');
        this.loading.set(false);
      },
    });
  }

  protected cancelTwoFactor(): void {
    this.ticket.set(null);
    this.codeForm.reset({ code: '' });
    this.errorKey.set(null);
    this.loading.set(false);
  }
}
