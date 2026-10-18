// iPhone home screen over USB: usbmuxd -> lockdownd (TLS) -> com.apple.springboardservices.
// Node port of hs.py's connection layer. macOS only (uses the system usbmuxd socket).
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const plist = require('plist');
const bplist = require('bplist-parser');

const USBMUXD = '/var/run/usbmuxd';
const LOCKDOWN_PORT = 62078;
const LABEL = 'homescreen-mvp';

class DeviceError extends Error {}

// ---- plist helpers ------------------------------------------------------
function encodePlist(obj) {
  return Buffer.from(plist.build(obj), 'utf8');
}
function decodePlist(buf) {
  if (buf.subarray(0, 8).toString('latin1') === 'bplist00') return bplist.parseBuffer(buf)[0];
  return plist.parse(buf.toString('utf8'));
}

// ---- buffered reader over a socket -------------------------------------
class Conn {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.onData = (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); };
    this.onEnd = () => { this.closed = true; this.pump(); };
    this.onError = (e) => { this.error = e; this.pump(); };
    sock.on('data', this.onData);
    sock.on('close', this.onEnd);
    sock.on('error', this.onError);
  }
  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (this.buf.length >= w.n) {
        this.waiters.shift();
        const out = this.buf.subarray(0, w.n);
        this.buf = this.buf.subarray(w.n);
        w.resolve(out);
      } else if (this.error || this.closed) {
        this.waiters.shift();
        w.reject(this.error || new DeviceError('裝置中斷連線（線被拔掉或手機鎖定了？）'));
      } else break;
    }
  }
  read(n, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const w = { n };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new DeviceError('等待手機回應逾時，請確認手機已解鎖'));
      }, timeoutMs);
      w.resolve = (v) => { clearTimeout(timer); resolve(v); };
      w.reject = (e) => { clearTimeout(timer); reject(e); };
      this.waiters.push(w);
      this.pump();
    });
  }
  write(b) { this.sock.write(b); }
  detach() {  // hand the raw socket to TLS
    this.sock.off('data', this.onData);
    this.sock.off('close', this.onEnd);
    this.sock.off('error', this.onError);
    return this.sock;
  }
  close() { this.sock.destroy(); }
  // lockdown / service framing: 4-byte big-endian length + plist
  async sendPlist(obj) {
    const body = encodePlist(obj);
    const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
    this.write(Buffer.concat([head, body]));
  }
  async recvPlist(timeoutMs) {
    const n = (await this.read(4, timeoutMs)).readUInt32BE(0);
    return decodePlist(await this.read(n, timeoutMs));
  }
}

// ---- usbmuxd -------------------------------------------------------------
function openMux() {
  if (!fs.existsSync(USBMUXD)) throw new DeviceError('找不到 usbmuxd，這個工具目前只支援 macOS');
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(USBMUXD, () => resolve(new Mux(sock)));
    sock.once('error', reject);
  });
}

class Mux {
  constructor(sock) { this.conn = new Conn(sock); this.tag = 0; }
  async request(msg) {
    const body = encodePlist({ ...msg, ClientVersionString: LABEL, ProgName: LABEL, kLibUSBMuxVersion: 3 });
    const head = Buffer.alloc(16);
    head.writeUInt32LE(16 + body.length, 0);
    head.writeUInt32LE(1, 4);   // version
    head.writeUInt32LE(8, 8);   // plist message
    head.writeUInt32LE(++this.tag, 12);
    this.conn.write(Buffer.concat([head, body]));
    const len = (await this.conn.read(16)).readUInt32LE(0);
    return decodePlist(await this.conn.read(len - 16));
  }
  async devices() {
    const r = await this.request({ MessageType: 'ListDevices' });
    return (r.DeviceList || [])
      .filter((d) => (d.Properties?.ConnectionType || 'USB') === 'USB')
      .map((d) => ({ id: d.DeviceID, udid: d.Properties?.SerialNumber }));
  }
  async pairRecord(udid) {
    const r = await this.request({ MessageType: 'ReadPairRecord', PairRecordID: udid });
    if (!r.PairRecordData) throw new DeviceError('這台 Mac 還沒被手機信任：請解鎖手機並點「信任」，或先用 Finder 連一次');
    return decodePlist(Buffer.from(r.PairRecordData));
  }
  async connect(deviceId, port) {
    const portBE = ((port & 0xff) << 8) | (port >> 8);
    const r = await this.request({ MessageType: 'Connect', DeviceID: deviceId, PortNumber: portBE });
    if (r.Number !== 0) throw new DeviceError(`無法連到手機的服務埠 ${port}（代碼 ${r.Number}）`);
    return this.conn;  // now a raw tunnel to the device
  }
  close() { this.conn.close(); }
}

// ---- TLS with the pair record's host certificate -------------------------
function tlsWrap(conn, record) {
  const raw = conn.detach();
  const base = {
    socket: raw,
    cert: Buffer.from(record.HostCertificate),
    key: Buffer.from(record.HostPrivateKey),
    rejectUnauthorized: false,   // the device cert is self-signed, as with Finder
    minVersion: 'TLSv1.2',
  };
  let opts = { ...base, ciphers: 'ALL:!aNULL:!eNULL:@SECLEVEL=0' };  // pair certs are often SHA-1 signed
  try { tls.createSecureContext(opts); } catch { opts = base; }      // Electron's BoringSSL has no SECLEVEL
  return new Promise((resolve, reject) => {
    const s = tls.connect(opts, () => resolve(new Conn(s)));
    s.once('error', reject);
  });
}

// ---- a session with one iPhone ---------------------------------------------
class Device {
  static async open(udid) {
    const mux = await openMux();
    let devs;
    try { devs = await mux.devices(); } finally { mux.close(); }
    if (!devs.length) throw new DeviceError('沒偵測到 iPhone：請用 USB 線連接並解鎖手機（Wi-Fi 不行）');
    if (udid) devs = devs.filter((d) => d.udid === udid);
    if (!devs.length) throw new DeviceError(`找不到裝置 ${udid}`);
    const d = new Device(devs[0]);
    const m2 = await openMux();
    try { d.record = await m2.pairRecord(d.udid); } finally { m2.close(); }
    await d.startLockdown();
    return d;
  }
  constructor({ id, udid }) { this.id = id; this.udid = udid; }

  async tunnel(port) { return (await openMux()).connect(this.id, port); }

  async startLockdown() {
    let c = await this.tunnel(LOCKDOWN_PORT);
    await c.sendPlist({ Label: LABEL, Request: 'QueryType' });
    const q = await c.recvPlist();
    if (q.Type !== 'com.apple.mobile.lockdown') throw new DeviceError('手機回應格式不符（lockdown）');
    await c.sendPlist({ Label: LABEL, Request: 'StartSession', HostID: this.record.HostID, SystemBUID: this.record.SystemBUID });
    const r = await c.recvPlist();
    if (r.Error) throw new DeviceError(`手機拒絕連線（${r.Error}），請在手機上重新信任這台 Mac`);
    if (r.EnableSessionSSL) c = await tlsWrap(c, this.record);
    this.lockdown = c;
  }

  async startService(name) {
    await this.lockdown.sendPlist({ Label: LABEL, Request: 'StartService', Service: name });
    const r = await this.lockdown.recvPlist();
    if (r.Error || !r.Port) {
      const hint = String(r.Error || '').includes('Password') ? '，請先解鎖手機' : '';
      throw new DeviceError(`無法啟動 ${name}：${r.Error || JSON.stringify(r)}${hint}`);
    }
    const c = await this.tunnel(r.Port);
    return r.EnableServiceSSL ? tlsWrap(c, this.record) : c;
  }

  async deviceName() {
    await this.lockdown.sendPlist({ Label: LABEL, Request: 'GetValue', Key: 'DeviceName' });
    return (await this.lockdown.recvPlist(5000)).Value || null;
  }

  async springboard(fn) {
    const s = await this.startService('com.apple.springboardservices');
    try { return await fn(s); } finally { s.close(); }
  }

  // Real icons straight from the phone, as data URIs. One connection, one request per app.
  async iconImages(bundleIds) {
    if (!bundleIds.length) return {};
    return this.springboard(async (s) => {
      const out = {};
      for (const id of bundleIds) {
        try {
          await s.sendPlist({ command: 'getIconPNGData', bundleId: id });
          const r = await s.recvPlist(8000);
          if (r.pngData) out[id] = 'data:image/png;base64,' + Buffer.from(r.pngData).toString('base64');
        } catch (e) {
          if (s.closed || s.error) break;  // connection gone: keep what we have, the UI falls back to letters
        }
      }
      return out;
    });
  }

  async getIconState() {
    const s = await this.startService('com.apple.springboardservices');
    try {
      await s.sendPlist({ command: 'getIconState', formatVersion: '2' });
      return await s.recvPlist(30000);
    } finally { s.close(); }
  }

  async setIconState(state) {
    const s = await this.startService('com.apple.springboardservices');
    try {
      await s.sendPlist({ command: 'setIconState', iconState: state });  // no reply
      await sleep(1000);
    } finally { s.close(); }
    await sleep(2000);  // let SpringBoard re-layout before re-reading
  }

  close() { this.lockdown?.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { Device, DeviceError, encodePlist, decodePlist };
