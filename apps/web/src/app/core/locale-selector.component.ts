import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AppLocale, I18nService, SUPPORTED_LANGUAGES } from './i18n.service';

const LANGUAGE_LABELS: Record<AppLocale, string> = {
  el: 'Ελληνικά',
  en: 'English',
  zh: '中文',
  pt: 'Português',
  ja: '日本語',
  es: 'Español',
};

@Component({
  selector: 'app-locale-selector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <select
      class="input !w-auto !py-1.5 text-xs"
      aria-label="Γλώσσα"
      [value]="i18n.currentLocale()"
      (change)="onChange($event)"
    >
      @for (locale of locales; track locale) {
        <option [value]="locale">{{ labels[locale] }}</option>
      }
    </select>
  `,
})
export class LocaleSelectorComponent {
  protected readonly i18n = inject(I18nService);
  protected readonly locales = SUPPORTED_LANGUAGES;
  protected readonly labels = LANGUAGE_LABELS;

  protected onChange(event: Event): void {
    this.i18n.setLocale((event.target as HTMLSelectElement).value);
  }
}
