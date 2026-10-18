// Groups apps into folders by App Store category. Pure functions, so changes regroup instantly.

export interface AppMeta {
  key: string; bundleId: string | null; name: string; where: string; origin: string | null; page: number;
  genre: string | null; icon: string | null;
}
export interface Folder { name: string; apps: string[]; }

const GENRE: Record<string, string> = {
  Games: '遊戲', Entertainment: '娛樂', 'Photo & Video': '影音', Music: '影音', Graphics: '影音', 'Graphics & Design': '影音',
  'Social Networking': '社群', Finance: '理財', Business: '工作', Productivity: '工作',
  Utilities: '工具', 'Developer Tools': '工具', Education: '學習', Reference: '學習', Books: '學習',
  Travel: '旅遊', Navigation: '旅遊', Weather: '旅遊', 'Food & Drink': '生活', Lifestyle: '生活',
  Shopping: '購物', 'Health & Fitness': '健康', Medical: '健康', News: '新聞', Magazines: '新聞', Sports: '運動',
};

export function typeOf(a: AppMeta): string {
  if (a.genre) return GENRE[a.genre] ?? '其他';
  return a.bundleId?.startsWith('com.apple.') ? 'Apple 內建' : '其他';
}

/** One folder per type, biggest first. Types with fewer than `minSize` apps go into 其他. */
export function group(apps: AppMeta[], minSize = 2): Folder[] {
  const byType = new Map<string, string[]>();
  for (const a of apps) {
    const t = typeOf(a);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(a.key);
  }
  const other: string[] = byType.get('其他') ?? [];
  byType.delete('其他');
  for (const [t, keys] of [...byType]) if (keys.length < minSize) { other.push(...keys); byType.delete(t); }
  const out = [...byType].sort((a, b) => b[1].length - a[1].length).map(([name, keys]) => ({ name, apps: keys }));
  if (other.length) out.push({ name: '其他', apps: other });
  return out;
}

const TINTS = ['#FF9F0A', '#30D158', '#0A84FF', '#BF5AF2', '#FF375F', '#64D2FF', '#FFD60A', '#5E5CE6'];
/** A stable color for apps without an icon. */
export const tint = (s: string) => TINTS[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TINTS.length];
