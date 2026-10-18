const { app, BrowserWindow, ipcMain, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { Device } = require('./device');
const { flatten, build, pages, bundleIds } = require('./layout');
const { metadata } = require('./classify');
const { encodePlist, decodePlist } = require('./device');

const DIST = path.join(__dirname, '..', 'dist', 'homescreen-mvp', 'browser');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const DONATE_URL = 'https://buymeacoffee.com/jayden_lim';
const backupDir = () => path.join(app.getPath('userData'), 'backups');
let lastState = null;
let sessionBackup = null;
const iconCache = new Map();  // bundleId -> data URI, fetched from the phone once per session  // the layout as it was before this session changed anything

// Every IPC call returns {ok, data} or {ok:false, error} so the UI can show the message.
function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
}

// Pages for the UI, plus any icons we have not fetched yet.
async function describe(d, state) {
  const pg = pages(state);
  const missing = bundleIds(pg).filter((id) => !iconCache.has(id));
  for (const [id, uri] of Object.entries(await d.iconImages(missing))) iconCache.set(id, uri);
  return { pages: pg, icons: Object.fromEntries(iconCache) };
}

async function withDevice(fn) {
  const d = await Device.open();
  try { return await fn(d); } finally { d.close(); }
}

handle('read', () => withDevice(async (d) => {
  const state = await d.getIconState();
  lastState = state;
  fs.mkdirSync(backupDir(), { recursive: true });
  const file = path.join(backupDir(), `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.plist`);
  fs.writeFileSync(file, encodePlist(state));
  if (!sessionBackup) sessionBackup = file;
  const items = flatten(state);
  return { udid: d.udid, name: await d.deviceName().catch(() => null), backup: sessionBackup,
    count: items.filter((i) => i.movable).length, fixed: items.filter((i) => !i.movable).length, ...(await describe(d, state)) };
}));

handle('metadata', async () => {
  if (!lastState) throw new Error('請先讀取 iPhone');
  const apps = await metadata(flatten(lastState));
  for (const a of apps) a.icon = iconCache.get(a.bundleId) || a.icon;  // the phone's own icon beats the store's
  return apps;
});

handle('apply', (plan) => withDevice(async (d) => {
  const current = await d.getIconState();  // build on the phone's latest state, not a stale copy
  const next = build(current, plan);
  await d.setIconState(next);
  const after = await d.getIconState();
  lastState = after;
  return describe(d, after);
}));

handle('restore', () => withDevice(async (d) => {
  const file = sessionBackup;
  if (!file) throw new Error('這次還沒讀取過手機，沒有備份可以還原');
  await d.setIconState(decodePlist(fs.readFileSync(file)));
  lastState = await d.getIconState();
  return { file, ...(await describe(d, lastState)) };
}));

// The URL is fixed here so the renderer can never open arbitrary links.
handle('donate', () => shell.openExternal(DONATE_URL));

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    let file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });
  const mac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 980, minHeight: 640,
    title: '主畫面整理',
    ...(mac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 }, vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' }
      : { backgroundColor: '#1E1E1E' }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL('app://local/index.html');
});

app.on('window-all-closed', () => app.quit());
