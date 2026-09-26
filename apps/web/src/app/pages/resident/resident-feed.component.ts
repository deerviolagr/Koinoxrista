import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, catchError, finalize, of } from 'rxjs';
import type { AnnouncementCommentDto, AnnouncementDto } from '@org/shared';
import { AuthService } from '../../core/auth.service';
import { AnnouncementsApiService } from '../../core/api/announcements-api.service';
import { ToastService } from '../../ui/toast.service';

/** Groups the feed into day buckets; pinned items stay first in their group. */
export function groupByDay(
  items: AnnouncementDto[],
): { day: string; items: AnnouncementDto[] }[] {
  const groups: { day: string; items: AnnouncementDto[] }[] = [];
  const indexByDay = new Map<string, number>();
  for (const item of items) {
    const day = new Date(item.createdAt).toLocaleDateString('el-GR', {
      dateStyle: 'full',
    });
    let index = indexByDay.get(day);
    if (index === undefined) {
      index = groups.length;
      indexByDay.set(day, index);
      groups.push({ day, items: [] });
    }
    groups[index].items.push(item);
  }
  return groups;
}

/** Immutably adds/removes an id from a signal-backed set (pure helper). */
export function toggleSetId(
  current: ReadonlySet<string>,
  id: string,
  enabled: boolean,
): ReadonlySet<string> {
  const next = new Set(current);
  if (enabled) next.add(id);
  else next.delete(id);
  return next;
}

@Component({
  selector: 'app-resident-feed',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="mb-6 text-xl font-bold text-slate-900">Ανακοινώσεις</h1>

    @if (loading()) {
      <div class="card text-sm text-slate-500">Φόρτωση…</div>
    } @else if (error()) {
      <div class="card border-red-200 bg-red-50 text-sm text-red-700">
        Αποτυχία φόρτωσης ανακοινώσεων.
      </div>
    } @else {
      <div class="flex flex-col gap-5">
        @for (group of feed(); track group.day) {
          <p
            class="text-xs font-semibold uppercase tracking-wide text-slate-400"
          >
            {{ group.day }}
          </p>
          @for (item of group.items; track item.id) {
            <article class="card flex flex-col gap-3">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <h2 class="font-semibold text-slate-900">
                    @if (item.pinned) {
                      <span title="Καρφιτσωμένη" aria-label="Καρφιτσωμένη"
                        >📌
                      </span>
                    }
                    {{ item.title }}
                  </h2>
                  <p class="text-xs text-slate-500">
                    {{ formatDateTime(item.createdAt) }} ·
                    {{ item.authorName || 'Διαχειριστής' }}
                  </p>
                </div>
                @if (item.pinned) {
                  <span class="badge shrink-0 bg-amber-100 text-amber-800"
                    >Καρφιτσωμένη</span
                  >
                }
              </div>
              <p class="whitespace-pre-line text-sm text-slate-600">
                {{ item.body }}
              </p>

              <div class="border-t border-slate-100 pt-3">
                <button
                  type="button"
                  class="btn btn-secondary !px-2 !py-1 text-xs"
                  [disabled]="isLoadingComments(item.id)"
                  (click)="toggleComments(item)"
                >
                  Σχόλια ({{ item.commentsCount }})
                </button>

                @if (openId() === item.id) {
                  <div class="mt-3 flex flex-col gap-3">
                    @if (isLoadingComments(item.id)) {
                      <p class="text-xs text-slate-500">Φόρτωση σχολίων…</p>
                    } @else {
                      @for (
                        entry of comments()[item.id] || [];
                        track entry.id
                      ) {
                        <div
                          class="rounded-lg border border-slate-100 bg-slate-50 p-3"
                        >
                          <div class="flex items-start justify-between gap-2">
                            <p class="text-xs font-medium text-slate-700">
                              {{ entry.authorName || 'Μέλος' }}
                              <span class="font-normal text-slate-400"
                                >·
                                {{ formatDateTime(entry.createdAt) }}
                              </span>
                            </p>
                            @if (canDelete(entry)) {
                              <button
                                type="button"
                                class="text-xs text-red-600 hover:underline"
                                [disabled]="isDeleting(entry.id)"
                                (click)="deleteComment(item, entry)"
                              >
                                Διαγραφή
                              </button>
                            }
                          </div>
                          <p
                            class="mt-1 whitespace-pre-line text-sm text-slate-600"
                          >
                            {{ entry.body }}
                          </p>
                        </div>
                      } @empty {
                        <p class="text-xs text-slate-500">
                          Κανένα σχόλιο ακόμη — κάντε την πρώτη ερώτηση.
                        </p>
                      }
                    }

                    @if (commentError(item.id); as message) {
                      <p class="field-error">{{ message }}</p>
                    }

                    <div class="flex flex-col gap-2">
                      <textarea
                        rows="2"
                        class="input"
                        maxlength="1000"
                        [value]="draftFor(item.id)"
                        [disabled]="isPosting(item.id)"
                        placeholder="Γράψτε μια ερώτηση ή απάντηση…"
                        (input)="setDraft(item.id, $event)"
                      ></textarea>
                      <button
                        type="button"
                        class="btn btn-primary self-start"
                        [disabled]="isPosting(item.id)"
                        (click)="postComment(item)"
                      >
                        {{ isPosting(item.id) ? 'Αποστολή…' : 'Αποστολή' }}
                      </button>
                    </div>
                  </div>
                }
              </div>
            </article>
          }
        } @empty {
          <div class="card text-sm text-slate-500">
            Δεν υπάρχουν ανακοινώσεις ακόμη.
          </div>
        }
      </div>
    }
  `,
})
export class ResidentFeedPage implements OnInit {
  private readonly announcementsApi = inject(AnnouncementsApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly feed = computed(() => groupByDay(this.items()));
  protected readonly items = signal<AnnouncementDto[]>([]);
  protected readonly comments = signal<
    Record<string, AnnouncementCommentDto[]>
  >({});
  protected readonly drafts = signal<Record<string, string>>({});
  protected readonly commentErrors = signal<Record<string, string | undefined>>(
    {},
  );
  protected readonly openId = signal<string | null>(null);

  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  protected readonly commentsLoading = signal<ReadonlySet<string>>(new Set());
  protected readonly posting = signal<ReadonlySet<string>>(new Set());
  protected readonly deleting = signal<ReadonlySet<string>>(new Set());

  private buildingId: string | null = null;

  ngOnInit(): void {
    this.buildingId = this.auth.currentUser()?.buildingId ?? null;
    if (!this.buildingId) {
      this.error.set(true);
      this.loading.set(false);
      return;
    }
    this.reload();
  }

  protected canDelete(entry: AnnouncementCommentDto): boolean {
    const user = this.auth.currentUser();
    return (
      user !== null &&
      (user.role === 'ADMIN' ||
        user.role === 'BUILDING_OWNER' ||
        user.id === entry.authorId)
    );
  }

  protected draftFor(announcementId: string): string {
    return this.drafts()[announcementId] ?? '';
  }

  protected commentError(announcementId: string): string | undefined {
    return this.commentErrors()[announcementId];
  }

  protected isLoadingComments(announcementId: string): boolean {
    return this.commentsLoading().has(announcementId);
  }

  protected isPosting(announcementId: string): boolean {
    return this.posting().has(announcementId);
  }

  protected isDeleting(commentId: string): boolean {
    return this.deleting().has(commentId);
  }

  protected toggleComments(item: AnnouncementDto): void {
    if (this.openId() === item.id) {
      this.openId.set(null);
      return;
    }
    this.openId.set(item.id);
    if (this.comments()[item.id] || this.isLoadingComments(item.id)) return;
    this.commentsLoading.update((ids) => toggleSetId(ids, item.id, true));
    this.commentErrors.update((errors) => ({
      ...errors,
      [item.id]: undefined,
    }));
    this.announcementsApi
      .comments(item.id)
      .pipe(
        catchError(() => of(null)),
        finalize(() =>
          this.commentsLoading.update((ids) =>
            toggleSetId(ids, item.id, false),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((entries) => {
        if (entries === null) {
          this.commentErrors.update((errors) => ({
            ...errors,
            [item.id]: 'Η φόρτωση των σχολίων απέτυχε.',
          }));
          return;
        }
        this.comments.update((current) => ({ ...current, [item.id]: entries }));
      });
  }

  protected setDraft(announcementId: string, event: Event): void {
    const body = (event.target as HTMLTextAreaElement).value;
    this.drafts.update((current) => ({ ...current, [announcementId]: body }));
  }

  protected postComment(item: AnnouncementDto): void {
    const body = this.draftFor(item.id).trim();
    if (!body) {
      this.commentErrors.update((errors) => ({
        ...errors,
        [item.id]: 'Το σχόλιο δεν μπορεί να είναι κενό.',
      }));
      return;
    }
    if (body.length > 1000) {
      this.commentErrors.update((errors) => ({
        ...errors,
        [item.id]: 'Το σχόλιο δεν μπορεί να ξεπερνά τους 1000 χαρακτήρες.',
      }));
      return;
    }
    if (this.isPosting(item.id)) return;
    this.posting.update((ids) => toggleSetId(ids, item.id, true));
    this.commentErrors.update((errors) => ({
      ...errors,
      [item.id]: undefined,
    }));
    this.announcementsApi
      .addComment(item.id, { body })
      .pipe(
        finalize(() =>
          this.posting.update((ids) => toggleSetId(ids, item.id, false)),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (created) => {
          this.drafts.update((current) => ({ ...current, [item.id]: '' }));
          this.comments.update((current) => ({
            ...current,
            [item.id]: [...(current[item.id] ?? []), created],
          }));
          this.bumpCommentsCount(item.id, 1);
          this.toast.success('Το σχόλιο δημοσιεύτηκε.');
        },
        error: () => {
          this.commentErrors.update((errors) => ({
            ...errors,
            [item.id]: 'Η αποστολή του σχολίου απέτυχε.',
          }));
        },
      });
  }

  protected deleteComment(
    item: AnnouncementDto,
    entry: AnnouncementCommentDto,
  ): void {
    if (this.isDeleting(entry.id)) return;
    this.deleting.update((ids) => toggleSetId(ids, entry.id, true));
    this.commentErrors.update((errors) => ({
      ...errors,
      [item.id]: undefined,
    }));
    this.announcementsApi
      .deleteComment(item.id, entry.id)
      .pipe(
        finalize(() =>
          this.deleting.update((ids) => toggleSetId(ids, entry.id, false)),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.comments.update((current) => ({
            ...current,
            [item.id]: (current[item.id] ?? []).filter(
              (c) => c.id !== entry.id,
            ),
          }));
          this.bumpCommentsCount(item.id, -1);
        },
        error: () => {
          this.commentErrors.update((errors) => ({
            ...errors,
            [item.id]: 'Η διαγραφή του σχολίου απέτυχε.',
          }));
        },
      });
  }

  protected formatDateTime(iso: string): string {
    return new Date(iso).toLocaleString('el-GR', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  }

  private bumpCommentsCount(announcementId: string, delta: number): void {
    this.items.update((current) =>
      current.map((item) =>
        item.id === announcementId
          ? { ...item, commentsCount: Math.max(0, item.commentsCount + delta) }
          : item,
      ),
    );
  }

  private reload(): void {
    const buildingId = this.buildingId;
    if (!buildingId) return;
    this.loading.set(true);
    this.error.set(false);
    this.announcementsApi
      .feed(buildingId)
      .pipe(
        catchError(() => {
          this.error.set(true);
          this.loading.set(false);
          return EMPTY;
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((items) => {
        this.items.set(items);
        this.loading.set(false);
      });
  }
}
