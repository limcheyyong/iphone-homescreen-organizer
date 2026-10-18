// Pure layout logic (port of hs.py): describe pages, flatten icons, build a new state from a plan.
// Apple apps sometimes come without a displayName
const APPLE_NAMES = {
  'com.apple.MobileSMS': '訊息', 'com.apple.mobilephone': '電話', 'com.apple.mobilesafari': 'Safari', 'com.apple.Music': '音樂',
  'com.apple.mobilemail': '郵件', 'com.apple.mobilecal': '行事曆', 'com.apple.mobileslideshow': '照片', 'com.apple.camera': '相機',
  'com.apple.weather': '天氣', 'com.apple.mobilenotes': '備忘錄', 'com.apple.Preferences': '設定', 'com.apple.AppStore': 'App Store',
  'com.apple.facetime': 'FaceTime', 'com.apple.mobiletimer': '時鐘', 'com.apple.reminders': '提醒事項', 'com.apple.Maps': '地圖',
};
const key = (i) => i.displayName || APPLE_NAMES[i.bundleIdentifier] || i.bundleIdentifier || '?';
const isFolder = (i) => i && i.listType === 'folder';
const members = (f) => f.iconLists.flat();
const chunk = (xs, n) => { const out = []; for (let k = 0; k < xs.length; k += n) out.push(xs.slice(k, k + n)); return out.length ? out : [[]]; };

// ---- widgets ---------------------------------------------------------------
const isStack = (i) => i && Array.isArray(i.iconLists) && !isFolder(i);
const isWidget = (x) => Boolean(x.gridSize) || /widget/i.test(String(x.elementType || x.iconType || '')) ||
  (!x.displayName && /widget|extension/i.test(x.bundleIdentifier || ''));
// Readable names for Apple's own widgets, keyed by the last part of the app's bundle id.
const APPLE_WIDGETS = {
  batteries: '電池', weather: '天氣', mobilecal: '行事曆', mobiletimer: '時鐘', mobileslideshow: '照片', reminders: '提醒事項',
  maps: '地圖', news: '新聞', stocks: '股市', fitness: '健身', health: '健康', mobilenotes: '備忘錄', findmy: '尋找',
  music: '音樂', podcasts: 'Podcast', home: '家庭', shortcuts: '捷徑', tips: '提示', screentimewidgetapplication: '螢幕使用時間',
  mobilesafari: 'Safari', files: '檔案', tv: 'TV', journal: '手記', contacts: '聯絡人', mobilemail: '郵件', sleep: '睡眠',
};
function containerOf(x) {
  if (x.containerBundleIdentifier) return x.containerBundleIdentifier;
  const parts = (x.bundleIdentifier || '').split('.');
  while (parts.length > 2 && /widget|extension|intent/i.test(parts[parts.length - 1])) parts.pop();
  return parts.join('.');
}
function prettify(s) {
  return s.replace(/(Widget|Extension|Intents?)+$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || s;
}
function widgetTile(x, names, stack = false) {
  const app = containerOf(x);
  const last = app.split('.').pop() || '';
  const size = String(x.gridSize || 'small').toLowerCase().replace(/[^a-z]/g, '');
  return {
    kind: 'widget', bundleId: app, stack,
    name: names.get(app) || APPLE_WIDGETS[last.toLowerCase()] || prettify(last),
    size: ['small', 'medium', 'large', 'extralarge'].includes(size) ? size : 'small',
  };
}

// ---- describing a state for the UI ---------------------------------------------
function appNames(state) {
  const names = new Map();
  for (const p of state) for (const it of p) for (const x of isFolder(it) ? members(it) : [it]) {
    if (x.bundleIdentifier && x.displayName) names.set(x.bundleIdentifier, x.displayName);
  }
  return names;
}
function tileOf(it, names) {
  if (isFolder(it)) return { kind: 'folder', name: it.displayName, apps: members(it).map((x) => ({ name: key(x), bundleId: x.bundleIdentifier || null })) };
  if (isStack(it)) {
    const first = it.iconLists.flat()[0] || {};
    return widgetTile({ ...first, gridSize: it.gridSize || first.gridSize }, names, true);
  }
  if (isWidget(it)) return widgetTile(it, names);
  return { kind: 'app', name: key(it), bundleId: it.bundleIdentifier || null };
}
function pages(state) {
  const names = appNames(state);
  return state.map((p, i) => ({ title: i === 0 ? 'Dock' : `第 ${i} 頁`, tiles: p.map((t) => tileOf(t, names)) }));
}
function bundleIds(pg) {
  const ids = new Set();
  for (const p of pg) for (const t of p.tiles) {
    if (t.bundleId) ids.add(t.bundleId);
    for (const a of t.apps || []) if (a.bundleId) ids.add(a.bundleId);
  }
  return [...ids];
}

// ---- flatten & build -------------------------------------------------------------
// Every icon on the home pages (not the dock), with a unique key and where it sits now.
function flatten(state, keep = []) {
  const items = [];
  const seen = new Map();
  state.slice(1).forEach((page, pi) => {
    if (keep.includes(pi + 1)) return;  // pinned pages stay exactly as they are
    for (const it of page) {
      const inFolder = isFolder(it);
      for (const x of inFolder ? members(it) : [it]) {
        let k = key(x);
        const n = (seen.get(k) || 0) + 1;
        seen.set(k, n);
        if (n > 1) k = `${k}#${n}`;
        items.push({
          key: k,
          name: key(x),
          bundleId: x.bundleIdentifier || null,
          origin: inFolder ? it.displayName : null,
          page: pi + 1,
          // widgets, stacks and other non-app tiles stay where they are
          movable: Boolean(x.bundleIdentifier) && !isWidget(x) && !isStack(x),
          where: `第 ${pi + 1} 頁` + (inFolder ? ` / ${it.displayName}` : ''),
          raw: x,
        });
      }
    }
  });
  return items;
}

// plan = { folders: [{ name, apps: [key] }], keepPages?: [1] } -> new icon state. The dock is untouched.
function build(state, plan) {
  const keep = plan.keepPages || [];
  const items = flatten(state, keep);
  const pool = new Map(items.map((i) => [i.key, i]));
  const oldFolders = new Map();
  for (const p of state.slice(1).filter((_, i) => !keep.includes(i + 1))) for (const it of p) if (isFolder(it)) oldFolders.set(it.displayName, it);
  const used = new Set();
  const take = (k) => {
    if (!pool.has(k)) throw new Error(`找不到 App：${k}`);
    if (used.has(k)) throw new Error(`App 重複出現：${k}`);
    used.add(k);
    return pool.get(k).raw;
  };
  const tiles = [];
  for (const f of plan.folders) {
    const apps = f.apps.map(take);
    if (!apps.length) continue;
    if (apps.length === 1) { tiles.push(apps[0]); continue; }  // a one-app folder is just the app
    const { iconLists, ...base } = oldFolders.get(f.name) || {};
    tiles.push({ ...base, displayName: f.name, listType: 'folder', iconLists: chunk(apps, 9) });
  }
  const left = items.filter((i) => !used.has(i.key)).map((i) => i.raw);  // never drop an icon (widgets included)
  const pinned = state.slice(1).filter((_, i) => keep.includes(i + 1));
  const out = [...pinned, ...chunk(tiles, 24), ...(left.length ? chunk(left, 24) : [])].filter((p) => p.length);
  return [state[0], ...out];
}

function summary(state) {
  return pages(state).map((p) => ({
    title: p.title,
    items: p.tiles.map((t) => t.kind === 'folder' ? `[${t.name}] ${t.apps.map((a) => a.name).join('、')}` : t.kind === 'widget' ? `〔小工具・${t.size}〕${t.name}` : t.name),
  }));
}

module.exports = { flatten, build, pages, bundleIds, summary };
