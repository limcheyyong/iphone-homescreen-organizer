import { Component, HostListener, computed, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { CdkDrag, CdkDragDrop, CdkDragPlaceholder, CdkDropList, CdkDropListGroup, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { AppMeta, Folder, group, tint } from './grouping';

interface Result<T> { ok: boolean; data?: T; error?: string; }
type Size = 'small' | 'medium' | 'large' | 'extralarge';
interface RawTile { kind: 'app' | 'folder' | 'widget'; name: string; bundleId: string | null; apps?: { name: string; bundleId: string | null }[]; size?: Size; stack?: boolean; }
interface Page { title: string; tiles: RawTile[]; }
interface Look { pages: Page[]; icons: Record<string, string>; }
interface ReadData extends Look { udid: string; name: string | null; backup: string; count: number; fixed: number; }
declare global {
  interface Window {
    hs?: {
      platform: string;
      read(): Promise<Result<ReadData>>;
      metadata(): Promise<Result<AppMeta[]>>;
      apply(plan: { folders: Folder[]; keepPages: number[] }): Promise<Result<Look>>;
      restore(): Promise<Result<Look & { file: string }>>;
      donate(): Promise<Result<void>>;
    };
  }
}

/** What the card grid draws: one card per folder, plus cards for loose apps and widgets. */
interface Cell { name: string; icon: string | null; note?: string; }
interface Card { kind: 'apps' | 'folder' | 'widgets'; name: string; cells: Cell[]; }

type View = 'current' | 'new';
type Sheet = null | 'apply' | 'restore';
const SIZE_LABEL: Record<Size, string> = { small: '小', medium: '中', large: '大', extralarge: '特大' };

@Component({
  selector: 'app-root',
  imports: [CdkDropListGroup, CdkDropList, CdkDrag, CdkDragPlaceholder, NgTemplateOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  // ---- session
  readonly device = signal<ReadData | null>(null);
  readonly look = signal<Look>({ pages: [], icons: {} });
  readonly meta = signal<AppMeta[] | null>(null);
  readonly applied = signal(false);
  // ---- ui
  readonly view = signal<View>('current');
  readonly busy = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly toast = signal<string | null>(null);
  readonly sheet = signal<Sheet>(null);
  readonly sortOpen = signal(false);
  readonly menu = signal<{ key: string; from: number; x: number; y: number } | null>(null);
  readonly inElectron = typeof window !== 'undefined' && !!window.hs;
  // ---- options
  readonly scope = signal<Set<number>>(new Set());   // home pages to reorganize; the rest stay as they are
  readonly minSize = signal(2);
  // ---- the new layout
  readonly folders = signal<Folder[]>([]);
  readonly edited = signal(false);
  readonly hasNew = computed(() => this.folders().length > 0);

  // ---- the current layout as cards
  private icon = (id: string | null) => (id && this.look().icons[id]) || null;
  private cards(tiles: RawTile[]): Card[] {
    const loose = tiles.filter((t) => t.kind === 'app');
    const widgets = tiles.filter((t) => t.kind === 'widget');
    return [
      ...(loose.length ? [{ kind: 'apps' as const, name: '主畫面上的 App', cells: loose.map((t) => ({ name: t.name, icon: this.icon(t.bundleId) })) }] : []),
      ...tiles.filter((t) => t.kind === 'folder').map((t) => ({ kind: 'folder' as const, name: t.name,
        cells: (t.apps ?? []).map((a) => ({ name: a.name, icon: this.icon(a.bundleId) })) })),
      ...(widgets.length ? [{ kind: 'widgets' as const, name: '小工具', cells: widgets.map((t) => ({ name: t.name, icon: this.icon(t.bundleId),
        note: (t.stack ? '堆疊・' : '') + SIZE_LABEL[t.size ?? 'small'] })) }] : []),
    ];
  }
  readonly dockCells = computed<Cell[]>(() => (this.look().pages[0]?.tiles ?? []).map((t) => ({ name: t.name, icon: this.icon(t.bundleId) })));
  readonly homePages = computed(() => this.look().pages.slice(1).map((p, i) => ({ title: p.title, n: i + 1, count: p.tiles.length, cards: this.cards(p.tiles) })));
  readonly scopeLabel = computed(() => {
    const on = this.homePages().filter((p) => this.scope().has(p.n)).map((p) => p.title);
    const off = this.homePages().filter((p) => !this.scope().has(p.n)).map((p) => p.title);
    if (!on.length) return '請先在選項裡選擇要整理的頁面。';
    return `會整理${on.join('、')}` + (off.length ? `，${off.join('、')}保持原樣。` : '。');
  });
  readonly keepPages = computed(() => this.homePages().map((p) => p.n).filter((n) => !this.scope().has(n)));
  readonly stats = computed(() => {
    const tiles = this.look().pages.slice(1).flatMap((p) => p.tiles);
    return { apps: this.device()?.count ?? 0, folders: tiles.filter((t) => t.kind === 'folder').length,
      widgets: tiles.filter((t) => t.kind === 'widget').length, pages: this.homePages().length };
  });

  // ---- the new layout
  readonly apps = computed(() => new Map((this.meta() ?? []).map((a) => [a.key, a])));
  readonly inScope = computed(() => (this.meta() ?? []).filter((a) => this.scope().has(a.page)));
  readonly folderCount = computed(() => this.folders().filter((f) => f.apps.length > 1).length);
  readonly movedCount = computed(() => this.folders().reduce((n, f) => n + f.apps.length, 0));
  readonly steps = computed(() => [
    { label: '連接 iPhone', done: !!this.device(), current: !this.device() },
    { label: '整理主畫面', done: this.applied(), current: !!this.device() && !this.applied() },
    { label: '套用到 iPhone', done: this.applied(), current: false },
  ]);

  constructor() {
    if (window.hs?.platform === 'darwin') document.documentElement.classList.add('vibrant');
  }

  // ---- main process calls
  private async run<T>(label: string, call: () => Promise<Result<T>>, quiet = false): Promise<T | null> {
    if (!window.hs) { this.error.set('請用 npm start 開啟桌面版，瀏覽器無法連接 USB。'); return null; }
    if (!quiet) this.busy.set(label);
    this.error.set(null);
    try {
      const r = await call();
      if (!r.ok) { this.error.set(r.error ?? '發生未知錯誤。'); return null; }
      return r.data ?? null;
    } finally { if (!quiet) this.busy.set(null); }
  }

  async read() {
    const d = await this.run('正在讀取 iPhone 和 App 圖示…', () => window.hs!.read());
    if (!d) return;
    this.device.set(d);
    this.look.set(d);
    this.applied.set(false);
    this.folders.set([]);
    this.view.set('current');
    // reorganize every page except the first (usually Apple's own apps) unless there is only one
    const n = d.pages.length - 1;
    this.scope.set(new Set(Array.from({ length: n }, (_, i) => i + 1).filter((p) => p !== 1 || n === 1)));
    this.meta.set(null);
    this.loadMeta();
  }

  private metaLoading?: Promise<void>;
  loadMeta() {
    this.metaLoading ??= (async () => {
      const m = await this.run('', () => window.hs!.metadata(), true);
      if (m) this.meta.set(m);
      this.metaLoading = undefined;
    })();
    return this.metaLoading;
  }

  async generate() {
    if (!this.meta()) {
      this.busy.set('正在查詢 App Store 類型…');
      await this.loadMeta();
      this.busy.set(null);
      if (!this.meta()) return;
    }
    const again = this.hasNew();
    this.folders.set(group(this.inScope(), this.minSize()));
    this.edited.set(false);
    this.sortOpen.set(false);
    this.view.set('new');
    if (again) this.notify('已重新依類型分類');
  }

  async confirmApply() {
    this.sheet.set(null);
    const plan = { keepPages: this.keepPages(), folders: this.folders().filter((f) => f.apps.length).map((f) => ({ name: f.name.trim() || '未命名', apps: f.apps })) };
    const d = await this.run('正在寫入 iPhone…', () => window.hs!.apply(plan));
    if (!d) return;
    this.afterWrite(d);
    this.applied.set(true);
    this.scope.set(new Set(this.homePages().map((p) => p.n).filter((n) => !plan.keepPages.includes(n))));
  }

  async confirmRestore() {
    this.sheet.set(null);
    const d = await this.run('正在還原…', () => window.hs!.restore());
    if (!d) return;
    this.afterWrite(d);
    this.applied.set(false);
    this.notify('已還原成原本的排版');
  }

  private afterWrite(d: Look) {
    this.look.set(d);
    this.folders.set([]);
    this.meta.set(null);       // page numbers changed: refetch for the next round
    this.view.set('current');
    this.loadMeta();
  }

  donate() {
    if (window.hs) window.hs.donate();
    else window.open('https://buymeacoffee.com/jayden_lim', '_blank');
  }

  togglePage(n: number) { this.scope.update((s) => { const c = new Set(s); c.has(n) ? c.delete(n) : c.add(n); return c; }); }

  // ---- manual arranging
  drop(e: CdkDragDrop<string[]>) {
    if (e.previousContainer === e.container) moveItemInArray(e.container.data, e.previousIndex, e.currentIndex);
    else transferArrayItem(e.previousContainer.data, e.container.data, e.previousIndex, e.currentIndex);
    this.folders.update((fs) => [...fs]);
    this.edited.set(true);
  }
  openMenu(ev: MouseEvent, key: string, from: number) {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set({ key, from, x: Math.min(r.left, window.innerWidth - 220), y: Math.min(r.bottom + 6, window.innerHeight - 320) });
  }
  moveTo(to: number) {
    const m = this.menu();
    if (!m) return;
    this.folders.update((fs) => { fs[m.from].apps = fs[m.from].apps.filter((k) => k !== m.key); fs[to].apps.push(m.key); return [...fs]; });
    this.notify(`已將「${this.info(m.key)?.name}」移到「${this.folders()[to].name}」`);
    this.menu.set(null);
    this.edited.set(true);
  }
  addFolder() {
    this.folders.update((fs) => [...fs, { name: '新資料夾', apps: [] }]);
    this.edited.set(true);
    queueMicrotask(() => (document.querySelector('.group.editable:last-of-type input') as HTMLInputElement | null)?.select());
  }
  removeFolder(i: number) {
    const gone = this.folders()[i];
    this.folders.update((fs) => {
      fs.splice(i, 1);
      if (gone.apps.length) {
        const other = fs.find((f) => f.name === '其他') ?? (fs.push({ name: '其他', apps: [] }), fs[fs.length - 1]);
        other.apps.push(...gone.apps);
      }
      return [...fs];
    });
    this.edited.set(true);
    if (gone.apps.length) this.notify(`「${gone.name}」裡的 App 已移到「其他」`);
  }
  rename(i: number, name: string) { this.folders.update((fs) => { fs[i] = { ...fs[i], name }; return [...fs]; }); this.edited.set(true); }

  // ---- helpers
  info(key: string) { return this.apps().get(key); }
  first(s: string) { return [...s][0] ?? '?'; }
  tint = tint;
  private toastTimer?: ReturnType<typeof setTimeout>;
  notify(text: string) {
    this.toast.set(text);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), 3200);
  }

  @HostListener('document:keydown.escape') escape() {
    this.menu.set(null);
    this.sortOpen.set(false);
    if (!this.busy()) this.sheet.set(null);
  }
  @HostListener('document:pointerdown', ['$event']) outside(e: PointerEvent) {
    const t = e.target as HTMLElement;
    if (this.menu() && !t.closest('.menu')) this.menu.set(null);
    if (this.sortOpen() && !t.closest('.popover, .sort-btn')) this.sortOpen.set(false);
  }
}
