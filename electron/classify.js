// App Store category for each app, from the public iTunes Lookup API. Grouping itself happens in the UI.
//   genre : the App Store category (English, e.g. "Finance"). Looked up in these stores, in order.
const STORES = ['tw', 'us', 'my', 'cn'];

async function lookup(bundleIds, country) {
  const out = new Map();
  for (let k = 0; k < bundleIds.length; k += 50) {
    const ids = bundleIds.slice(k, k + 50).join(',');
    try {
      const res = await fetch(`https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(ids)}&country=${country}`);
      const data = await res.json();
      for (const r of data.results || []) out.set(r.bundleId, { genre: r.primaryGenreName, icon: r.artworkUrl100 || r.artworkUrl60 });
    } catch { /* offline or rate-limited: those apps get no genre */ }
  }
  return out;
}

const cache = new Map();  // bundleId -> { genre, icon }

async function metadata(items) {
  const movable = items.filter((i) => i.movable);
  const missing = [...new Set(movable.map((i) => i.bundleId))].filter((id) => !cache.has(id));
  if (missing.length) {
    let left = missing;
    for (const store of STORES) {   // most apps resolve in the first store; only look further for the rest
      if (!left.length) break;
      const found = await lookup(left, store);
      for (const [id, meta] of found) cache.set(id, meta);
      left = left.filter((id) => !found.has(id));
    }
    for (const id of left) cache.set(id, { genre: null, icon: null });
  }
  return movable.map((it) => ({
    key: it.key, bundleId: it.bundleId, name: it.name, where: it.where, origin: it.origin, page: it.page,
    ...cache.get(it.bundleId),
  }));
}

module.exports = { metadata };
