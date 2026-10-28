/**
 * Smart-device installer - scan the LAN for Android TV / Fire TV devices with
 * ADB enabled, then one-click install + auto-pair the native TV app over ADB.
 *
 * Scan only TCP-probes port 5555 (never connects), so it doesn't trigger the
 * "Allow debugging?" dialog on every TV - that happens only when the user clicks
 * Install for a specific device. Install then: adb connect → wait for the user to
 * accept on that TV → adb install → am start (auto-pair via the hook) → grant
 * the overlay permission.
 *
 * Prereq the user must do once per device: enable ADB debugging in the TV's
 * Developer Options (otherwise :5555 isn't open and the device won't appear).
 */
const { spawn, execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const net = require('net');
const dns = require('dns');
const path = require('path');

const utils = require('./utils');
const auth = require('./auth');

const ADB_PORT = 5555;
const TV_PACKAGE = 'com.eufyview.tv';

// Per-ip install progress: ip -> { phase, message, at }.
const jobs = new Map();
function setJob(ip, phase, message) { jobs.set(ip, { phase, message: message || '', at: Date.now() }); }
function status() { return Object.fromEntries(jobs); }

function installRoot() { return path.dirname(utils.dataDir); }  // dataDir = <install>/data

// Resolve adb.exe: config.ADB_PATH → <install>/platform-tools/adb.exe → 'adb' on PATH.
function adbPath() {
    try {
        const cfg = utils.loadConfig();
        if (cfg.ADB_PATH && fs.existsSync(cfg.ADB_PATH)) return cfg.ADB_PATH;
    } catch (e) {}
    const bundled = path.join(installRoot(), 'platform-tools', 'adb.exe');
    if (fs.existsSync(bundled)) return bundled;
    return 'adb';
}

// Resolve the TV APK: config.TV_APK_PATH → <install>/EufyView-TV.apk.
function tvApkPath() {
    try {
        const cfg = utils.loadConfig();
        if (cfg.TV_APK_PATH && fs.existsSync(cfg.TV_APK_PATH)) return cfg.TV_APK_PATH;
    } catch (e) {}
    const p = path.join(installRoot(), 'EufyView-TV.apk');
    return fs.existsSync(p) ? p : null;
}

// --- Persistent record of devices we've installed the TV app on, keyed by MAC
// (stable across IP/DHCP changes) with the version that was installed. Lets a
// later scan show "already installed (vX)" and flag when an update is available. ---
function installsFile() { return path.join(utils.dataDir, 'tv-installs.json'); }

function loadInstalls() {
    try { return JSON.parse(fs.readFileSync(installsFile(), 'utf8').replace(/^﻿/, '')); }
    catch (e) { return {}; }
}

function recordInstall(mac, rec) {
    if (!mac) return;
    const all = loadInstalls();
    all[mac] = { ...(all[mac] || {}), ...rec };
    try { fs.writeFileSync(installsFile(), JSON.stringify(all, null, 2)); }
    catch (e) { utils.log('Could not save tv-installs.json: ' + e.message, 'warn'); }
}

function forgetInstall(mac) {
    if (!mac) return;
    const all = loadInstalls();
    if (!all[mac]) return;
    delete all[mac];
    try { fs.writeFileSync(installsFile(), JSON.stringify(all, null, 2)); }
    catch (e) { utils.log('Could not save tv-installs.json: ' + e.message, 'warn'); }
}

// The version of the TV APK this server currently bundles, from a sidecar file
// written at build time (EufyView-TV.apk.version, JSON {versionName,versionCode}).
// Optional - returns null if absent, in which case we just can't flag updates.
function tvApkVersion() {
    const apk = tvApkPath();
    if (!apk) return null;
    try {
        const v = JSON.parse(fs.readFileSync(apk + '.version', 'utf8').replace(/^﻿/, ''));
        if (v && v.versionName) return { versionName: String(v.versionName), versionCode: Number(v.versionCode) || null };
    } catch (e) {}
    return null;
}

function isPrivate(ip) {
    return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

// This server's site-local IPv4 (to hand to the TV as the server URL).
function serverLanIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const a of ifaces[name] || []) {
            if (a.family === 'IPv4' && !a.internal && isPrivate(a.address)) return a.address;
        }
    }
    return null;
}

function serverUrl() {
    const ip = serverLanIp();
    const cfg = (() => { try { return utils.loadConfig(); } catch (e) { return {}; } })();
    const port = cfg.PORT || process.env.PORT || 3001;
    return ip ? `http://${ip}:${port}` : null;
}

// Whether automatic LAN TV-install is viable here. It needs the server to sit on
// the same private network as the TVs (a home setup); a VPS has no reachable LAN
// to scan, so `serverLanIp()` is null there. (A cloud box with a private VPC IP
// can read as lanCapable; the scan then simply finds nothing, which is harmless.)
function environment() {
    const lanIp = serverLanIp();
    return {
        lanCapable: !!lanIp,
        lanIp: lanIp || null,
        platform: process.platform,   // 'win32' | 'linux' | ...
        hasApk: !!tvApkPath(),
    };
}

// Run adb with args → { code, stdout, stderr }.
function adb(args, timeoutMs = 15000) {
    return new Promise((resolve) => {
        let p;
        try { p = spawn(adbPath(), args, { windowsHide: true }); }
        catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e.message) }); }
        let out = '', err = '';
        const timer = setTimeout(() => { try { p.kill(); } catch (e) {} }, timeoutMs);
        p.stdout.on('data', d => out += d.toString());
        p.stderr.on('data', d => err += d.toString());
        p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
        p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(e.message) }); });
    });
}

// TCP probe (does NOT connect adb).
function probe(ip, port, timeoutMs = 600) {
    return new Promise((resolve) => {
        const s = new net.Socket();
        let done = false;
        const finish = (ok) => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(ok); } };
        s.setTimeout(timeoutMs);
        s.once('connect', () => finish(true));
        s.once('timeout', () => finish(false));
        s.once('error', () => finish(false));
        s.connect(port, ip);
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Dialog-free device identification (no adb connect) ----

// Reverse-DNS a LAN IP to a hostname (best-effort; some routers don't serve PTR).
function reverseDns(ip) {
    return new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 1200);
        dns.reverse(ip, (err, names) => {
            if (done) return; done = true; clearTimeout(t);
            resolve((!err && names && names[0]) ? names[0] : null);
        });
    });
}

// Parse the OS ARP table → { ip: MAC(upper, colon) }.
function arpTable() {
    return new Promise((resolve) => {
        execFile('arp', ['-a'], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
            const map = {};
            (stdout || '').split(/\r?\n/).forEach(line => {
                const m = line.match(/(\d+\.\d+\.\d+\.\d+)[\s)]+([0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5})/);
                if (m) map[m[1]] = m[2].replace(/-/g, ':').toUpperCase();
            });
            resolve(map);
        });
    });
}

// A curated (non-exhaustive) set of OUIs for a best-guess vendor label. Only
// claims a vendor for prefixes we list, so a wrong guess is avoided.
const AMAZON_OUIS = new Set(['0C:47:C9', '1C:12:B0', '34:D2:70', '38:F7:3D', '40:B4:CD', '44:65:0D', '50:DC:E7', '68:37:E9', '68:54:FD', '68:9A:87', '74:75:48', '74:C2:46', '84:D6:D0', '8C:2A:85', 'A0:02:DC', 'AC:63:BE', 'B0:47:BF', 'CC:9E:A2', 'F0:27:2D', 'F0:81:73', 'FC:65:DE', 'FC:A1:83']);
const GOOGLE_OUIS = new Set(['00:1A:11', '08:9E:08', '1C:F2:9A', '20:DF:B9', '30:FD:38', '3C:28:6D', '48:D6:D5', '54:60:09', '54:2A:A2', '6C:AD:F8', '94:EB:2C', 'A4:77:33', 'D8:6C:63', 'DA:A1:19', 'E4:F0:42', 'F4:F5:D8', 'F8:8F:CA']);

function vendorFor(mac) {
    if (!mac) return null;
    const oui = mac.slice(0, 8);
    if (AMAZON_OUIS.has(oui)) return 'Amazon (Fire TV)';
    if (GOOGLE_OUIS.has(oui)) return 'Google (Android TV)';
    return null;
}

// Identify one device WITHOUT touching adb (so a scan never pops the "Allow
// debugging?" dialog): MAC + vendor from the ARP table, plus a reverse-DNS
// hostname. The exact model is only resolvable over an adb session, which we do
// at install time (install() connects anyway) - not during a scan.
async function describe(ip, arps, installs, apkVer) {
    const mac = arps[ip] || null;
    const info = { ip, phase: (jobs.get(ip) || {}).phase || 'ready', mac, vendor: vendorFor(mac) };
    info.hostname = await reverseDns(ip);
    info.label = info.vendor || info.hostname || (mac ? 'TV (' + mac + ')' : null);
    // Already installed? Match by MAC and attach the recorded version.
    const rec = mac && installs && installs[mac];
    if (rec) {
        info.installed = true;
        info.installedVersion = rec.versionName || null;
        info.installedVersionCode = rec.versionCode || null;
        info.installedAt = rec.installedAt || null;
        info.updateAvailable = !!(apkVer && apkVer.versionCode && rec.versionCode && apkVer.versionCode > rec.versionCode);
    }
    return info;
}

// Scan this /24 for devices with ADB (:5555) open, then identify each.
async function scan() {
    const myip = serverLanIp();
    if (!myip) return { serverUrl: null, adb: adbPath(), apk: !!tvApkPath(), devices: [], error: 'no LAN IPv4' };
    const base = myip.replace(/\.\d+$/, '.');
    const probes = [];
    for (let n = 1; n <= 254; n++) {
        const ip = base + n;
        if (ip === myip) continue;
        probes.push(probe(ip, ADB_PORT).then(open => (open ? ip : null)));
    }
    const ips = (await Promise.all(probes)).filter(Boolean).sort();
    const arps = await arpTable();
    const installs = loadInstalls();
    const apkVer = tvApkVersion();
    const devices = await Promise.all(ips.map(ip => describe(ip, arps, installs, apkVer)));
    return { serverUrl: serverUrl(), adb: adbPath(), apk: !!tvApkPath(), apkVersion: apkVer, devices };
}

// Install + auto-pair on one device. Async; progress tracked in `jobs`.
async function install(ip) {
    const target = ip + ':' + ADB_PORT;
    const apk = tvApkPath();
    const url = serverUrl();
    if (!apk) { setJob(ip, 'error', 'TV APK not found on the server'); return; }
    if (!url) { setJob(ip, 'error', 'Could not determine the server LAN address'); return; }
    try {
        setJob(ip, 'connecting', 'Connecting - accept the "Allow debugging?" prompt on the TV…');
        await adb(['connect', target], 8000);

        // Wait for the user to accept on the TV (state goes unauthorized → device).
        let state = '';
        for (let i = 0; i < 45; i++) {
            const st = await adb(['-s', target, 'get-state'], 5000);
            state = (st.stdout || '').trim();
            if (state === 'device') break;
            if (state === 'unauthorized') setJob(ip, 'waiting-auth', 'Waiting for you to tap "Allow" on the TV…');
            await sleep(2000);
            await adb(['connect', target], 5000);
        }
        if (state !== 'device') { setJob(ip, 'error', 'Not authorized - no "Allow" tapped on the TV'); return; }

        // Guard: only install on an actual TV (Android TV / Fire TV). A phone or
        // tablet that happens to have wireless ADB enabled would otherwise get
        // the TV app pushed to it - a different device class we don't support
        // here. We can only tell once the device has authorized (getprop needs a
        // session), so we check now, before installing, and bail out if it's not
        // a TV. Signals: ro.build.characteristics contains "tv" (Android TV),
        // the leanback feature is present (Android TV / Fire TV), or the model is
        // a Fire TV (AFT*).
        const model = ((await adb(['-s', target, 'shell', 'getprop', 'ro.product.model'], 4000)).stdout || '').trim();
        const mfr = ((await adb(['-s', target, 'shell', 'getprop', 'ro.product.manufacturer'], 4000)).stdout || '').trim();
        const chars = ((await adb(['-s', target, 'shell', 'getprop', 'ro.build.characteristics'], 4000)).stdout || '').toLowerCase();
        let features = '';
        try { features = ((await adb(['-s', target, 'shell', 'pm', 'list', 'features'], 8000)).stdout || '').toLowerCase(); } catch (e) {}
        const isTv = chars.includes('tv')
            || features.includes('android.software.leanback')
            || features.includes('android.hardware.type.television')
            || /^aft/i.test(model);
        if (!isTv) {
            const what = (mfr || model) ? ((mfr ? mfr + ' ' : '') + (model || '')).trim() : 'this device';
            setJob(ip, 'error', 'Skipped: ' + what + ' looks like a phone/tablet, not a TV. The TV app is only for Fire TV / Android TV; install EufyView on phones from the browser instead.');
            return;
        }

        const label = (model && mfr && !model.toLowerCase().includes(mfr.toLowerCase())) ? (mfr + ' ' + model) : (model || 'TV');
        setJob(ip, 'installing', 'Installing the app on ' + label + '…');
        const inst = await adb(['-s', target, 'install', '-r', apk], 120000);
        if (!/Success/i.test(inst.stdout + inst.stderr)) {
            setJob(ip, 'error', 'Install failed: ' + (inst.stderr || inst.stdout).trim().slice(0, 200));
            return;
        }

        setJob(ip, 'pairing', 'Pairing and granting overlay permission…');
        const token = auth.mintDeviceTokenForAdmin();
        await adb(['-s', target, 'shell', 'am', 'start', '-n', TV_PACKAGE + '/.MainActivity',
            '-e', 'url', url, '-e', 'token', token, '-e', 'silent', 'true'], 10000);
        await adb(['-s', target, 'shell', 'appops', 'set', TV_PACKAGE, 'SYSTEM_ALERT_WINDOW', 'allow'], 8000);

        // Remember this device + the version we just installed, keyed by MAC, so
        // a later scan shows it as already installed and can flag future updates.
        // We record the version of the APK WE installed (we know it) rather than
        // querying the device - no extra adb round-trip, no re-prompt on the TV.
        // A future "update" flow will re-authorize adb and read the on-device
        // version then, to confirm it's truly out of date before updating.
        // (arpTable reads the OS ARP cache, not the device - no TV prompt.)
        const apkVer = tvApkVersion();
        const mac = (await arpTable())[ip] || null;
        recordInstall(mac, {
            ip, label,
            versionName: (apkVer && apkVer.versionName) || null,
            versionCode: (apkVer && apkVer.versionCode) || null,
            installedAt: Date.now(),
        });

        setJob(ip, 'done', 'Installed and paired' + (apkVer && apkVer.versionName ? ' (v' + apkVer.versionName + ')' : ''));
    } catch (e) {
        setJob(ip, 'error', e.message);
    } finally {
        try { await adb(['disconnect', target], 4000); } catch (e) {}
    }
}

// Uninstall the TV app from one device and forget its record. Async; progress in
// `jobs`. Needs an authorized adb session, so the TV shows "Allow debugging?" once.
async function uninstall(ip) {
    const target = ip + ':' + ADB_PORT;
    try {
        setJob(ip, 'connecting', 'Connecting - accept the "Allow debugging?" prompt on the TV...');
        await adb(['connect', target], 8000);

        let state = '';
        for (let i = 0; i < 45; i++) {
            const st = await adb(['-s', target, 'get-state'], 5000);
            state = (st.stdout || '').trim();
            if (state === 'device') break;
            if (state === 'unauthorized') setJob(ip, 'waiting-auth', 'Waiting for you to tap "Allow" on the TV...');
            await sleep(2000);
            await adb(['connect', target], 5000);
        }
        if (state !== 'device') { setJob(ip, 'error', 'Not authorized - no "Allow" tapped on the TV'); return; }

        setJob(ip, 'uninstalling', 'Removing the app...');
        const res = await adb(['-s', target, 'uninstall', TV_PACKAGE], 60000);
        if (!/Success/i.test(res.stdout + res.stderr)) {
            setJob(ip, 'error', 'Uninstall failed: ' + (res.stderr || res.stdout).trim().slice(0, 200));
            return;
        }

        const mac = (await arpTable())[ip] || null;   // ARP cache, not the device
        forgetInstall(mac);
        setJob(ip, 'removed', 'Uninstalled');
    } catch (e) {
        setJob(ip, 'error', e.message);
    } finally {
        try { await adb(['disconnect', target], 4000); } catch (e) {}
    }
}

module.exports = { scan, install, uninstall, status, serverUrl, environment };
