import { Injector } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { Router } from '@angular/router';
import * as Sentry from '@sentry/angular';
import { App } from './app/app';
import { appConfig } from './app/app.config';
import { AuthService } from './app/core/auth.service';
import { PushSubscriptionService } from './app/core/push-subscription.service';
import { safeReturnUrl } from './app/core/role.guard';
import { environment } from './environments/environment';

if (environment.sentryDsn) {
  Sentry.init({
    dsn: environment.sentryDsn,
    tracesSampleRate: 0.1,
  });
}

bootstrapApplication(App, appConfig)
  .then((appRef) => {
    registerServiceWorker();
    wireServiceWorkerNavigation(appRef.injector);
    void bootstrapPush(appRef.injector);
  })
  .catch((err) => {
    if (environment.sentryDsn) Sentry.captureException(err);
    console.error(err);
  });

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  const register = () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err) => console.warn('[sw] registration failed', err));
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/** Routes notification clicks without forcing a full-document reload. */
function wireServiceWorkerNavigation(injector: Injector): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data?.type !== 'NAVIGATE' || typeof data.url !== 'string') return;
    const url = safeReturnUrl(data.url, '/');
    void injector.get(Router).navigateByUrl(url);
  });
}

async function bootstrapPush(injector: Injector): Promise<void> {
  try {
    if (!injector.get(AuthService).currentUser()) return;
    await injector.get(PushSubscriptionService).enable();
  } catch (err) {
    console.warn('[push] init failed', err);
  }
}
