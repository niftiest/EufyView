/**
 * Update checker / self-updater
 *
 * Source of truth is the GitHub Releases API for this repo. We read the latest
 * release, compare its tag to the running package.json version, and expose:
 *   - check():  is there a newer release? (cached - GitHub allows only 60
 *               unauthenticated requests/hour, so we never hit it more than
 *               once per CHECK_TTL and persist the last answer across restarts)
 *   - apply():  download + launch the platform updater. What "apply" means
 *               depends on how this server was installed:
 *                 windows → download the signed installer and run it silently;
 *                           it stops the service, replaces files (preserving
 *                           data/), and relaunches.
 *                 docker  → notify only (a container can't replace itself).
 *                 manual  → notify only (git pull / npm by hand).
 *
 * The mobile PWA updates itself through the service worker (CACHE_NAME bump),
 * so it is intentionally NOT handled here.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const utils = require('./utils');

const REPO = process.env.UPDATE_REPO || 'niftiest/EufyView';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_TTL = Number(process.env.UPDATE_CHECK_TTL_MS) || 6 * 60 * 60 * 1000;  // 6h
// Two release assets matter here: the small app-files ZIP (the preferred
// self-update path - extracts into the user-writable install, no UAC) and the
// full Windows installer (fresh installs + the rare Node/FFmpeg bump; the
// self-update fallback when a release carries no ZIP).
const ZIP_ASSET = process.env.UPDATE_ZIP_ASSET || 'eufyview-app.zip';
const INSTALLER_ASSET = process.env.UPDATE_INSTALLER_ASSET || 'EufyView-Setup.exe';
// TV app (Android) release assets: the APK and a tiny sidecar carrying its
// versionName/versionCode, so the TV app can tell whether a release is newer
// than what it's running without parsing the APK.
const TV_APK_ASSET = process.env.UPDATE_TV_APK_ASSET || 'EufyView-TV.apk';
const TV_VERSION_ASSET = process.env.UPDATE_TV_VERSION_ASSET || 'EufyView-TV.apk.version';
const INSTALL_ROOT = require.main ? require.main.path : process.cwd();
const CACHE_FILE = path.join(utils.dataDir, 'update-check.json');

const CURRENT_VERSION = (() => {
    try { return require('../package.json').version; } catch (e) { return '0.0.0'; }
})();

let memCache = null;        // last check result ({ checkedAt, release, ... })
let inFlight = null;        // de-dupe concurrent checks

// ---------------------------------------------------------------------------
// Install-type detection
// ---------------------------------------------------------------------------

// How was this server deployed? Decides what apply() can do.
//   'windows' - installed via the Inno Setup installer (tray present); can self-update.
//   'docker'  - running in a container; notify only.
//   'manual'  - cloned/unzipped and run by hand; notify only.
function detectInstallType() {
    if (process.env.UPDATE_INSTALL_TYPE) return process.env.UPDATE_INSTALL_TYPE;
    // Docker leaves a marker file; also check cgroup on Linux.
    try {
        if (fs.existsSync('/.dockerenv')) return 'docker';
        if (process.platform === 'linux' &&
            /docker|containerd|kubepods/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'))) {
            return 'docker';
        }
    } catch (e) { /* not docker */ }
    // The Windows installer drops the tray exe beside the app and never ships a
    // .git dir - that's how we tell an installed copy from a dev checkout.
    if (process.platform === 'win32' && fs.existsSync(path.join(INSTALL_ROOT, 'EufyViewTray.exe'))) {
        return 'windows';
    }
    return 'manual';
}

function canSelfUpdate(installType) {
    return installType === 'windows';
}

// ---------------------------------------------------------------------------
// Version comparison (lenient semver: MAJOR.MINOR.PATCH, ignores pre-release)
// ---------------------------------------------------------------------------

function normalizeVersion(v) {
    return String(v || '').trim().replace(/^v/i, '');
}

// Returns >0 if a>b, <0 if a<b, 0 if equal. Missing parts count as 0.
function compareVersions(a, b) {
    const pa = normalizeVersion(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = normalizeVersion(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// HTTPS helpers
// ---------------------------------------------------------------------------

function httpsJson(url, { timeout = 8000 } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                // GitHub rejects requests without a User-Agent.
                'User-Agent': 'EufyView-Updater',
                'Accept': 'application/vnd.github+json'
            },
            timeout
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(httpsJson(res.headers.location, { timeout }));
            }
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`GitHub API ${res.statusCode}`));
                }
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('bad JSON from GitHub')); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('GitHub API timeout')));
        req.on('error', reject);
    });
}

// Download a URL to a file, following redirects (GitHub asset URLs 302 to S3).
// Returns { path, bytes }.
function download(url, destPath, { timeout = 60000, onProgress } = {}) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        let settled = false;
        const fail = (err) => {
            if (settled) return; settled = true;
            file.destroy();
            fs.unlink(destPath, () => {});
            reject(err);
        };
        const get = (u, redirects) => {
            if (redirects > 5) return fail(new Error('too many redirects'));
            const req = https.get(u, {
                headers: { 'User-Agent': 'EufyView-Updater', 'Accept': 'application/octet-stream' },
                timeout
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return get(res.headers.location, redirects + 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return fail(new Error(`download HTTP ${res.statusCode}`));
                }
                const total = parseInt(res.headers['content-length'], 10) || 0;
                let got = 0;
                res.on('data', (c) => {
                    got += c.length;
                    if (onProgress && total) onProgress(got / total);
                });
                res.pipe(file);
                file.on('finish', () => file.close(() => {
                    if (settled) return; settled = true;
                    resolve({ path: destPath, bytes: got });
                }));
            });
            req.on('timeout', () => req.destroy(new Error('download timeout')));
            req.on('error', fail);
        };
        file.on('error', fail);
        get(url, 0);
    });
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

function loadPersistedCache() {
    try {
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (raw && raw.checkedAt) return raw;
    } catch (e) { /* no cache yet */ }
    return null;
}

function persistCache(result) {
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2)); }
    catch (e) { utils.log(`⚠️ update cache write failed: ${e.message}`, 'warn'); }
}

function findAsset(release, name) {
    const a = (release.assets || []).find(x => x.name === name);
    return a ? { name: a.name, size: a.size, url: a.browser_download_url } : null;
}

function summarize(release) {
    if (!release) return null;
    const zip = findAsset(release, ZIP_ASSET);
    const exe = findAsset(release, INSTALLER_ASSET);
    return {
        tag: release.tag_name,
        version: normalizeVersion(release.tag_name),
        name: release.name || release.tag_name,
        notes: release.body || '',
        url: release.html_url,
        publishedAt: release.published_at,
        // `asset` kept for back-compat (the installer); `assets` carries all.
        asset: exe,
        assets: { zip, exe, tvApk: findAsset(release, TV_APK_ASSET), tvVersion: findAsset(release, TV_VERSION_ASSET) }
    };
}

// TV app update info for the native TV client. Reads the latest release's TV
// APK + its version sidecar, so the TV app can compare versionCode and (if
// newer) download the APK straight from the release. Cached for 10 min since
// the TV polls it. Never throws.
let tvCache = null;
async function tvInfo() {
    const now = Date.now();
    if (tvCache && (now - tvCache.at) < 10 * 60 * 1000) return tvCache.value;
    const res = await check();   // uses the shared 6h release cache
    const assets = (res.latest && res.latest.assets) || {};
    let value = { available: false, current: null, versionCode: null, versionName: null, url: null, tag: res.latest && res.latest.tag, notes: res.latest && res.latest.notes };
    if (assets.tvApk && assets.tvVersion) {
        try {
            const meta = await httpsJson(assets.tvVersion.url);   // {versionName, versionCode}
            value = {
                available: true,
                versionCode: Number(meta.versionCode) || null,
                versionName: meta.versionName || null,
                url: assets.tvApk.url,
                size: assets.tvApk.size,
                tag: res.latest.tag,
                notes: res.latest.notes
            };
        } catch (e) {
            utils.log(`⚠️ TV version sidecar fetch failed: ${e.message}`, 'warn');
        }
    }
    tvCache = { at: now, value };
    return value;
}

function buildResult(release, checkedAt, error) {
    const installType = detectInstallType();
    const latest = summarize(release);
    const updateAvailable = !!(latest && compareVersions(latest.version, CURRENT_VERSION) > 0);
    const hasAsset = !!(latest && latest.assets && (latest.assets.zip || latest.assets.exe));
    return {
        current: CURRENT_VERSION,
        latest,
        updateAvailable,
        installType,
        canSelfUpdate: updateAvailable && canSelfUpdate(installType) && hasAsset,
        checkedAt,
        error: error || null
    };
}

/**
 * Check for a newer release. Cached for CHECK_TTL; pass { force:true } to
 * bypass the cache (e.g. an explicit "Check now" tap). Never throws - on a
 * network/API error it returns the last good result (if any) with `.error` set.
 */
async function check({ force = false } = {}) {
    const now = Date.now();
    if (!memCache) memCache = loadPersistedCache();
    if (!force && memCache && (now - memCache.checkedAt) < CHECK_TTL) {
        // Recompute the derived fields (version/installType) off the cached
        // release in case the app was upgraded since the raw fetch.
        return buildResult(memCache.release, memCache.checkedAt, memCache.error);
    }
    if (inFlight) return inFlight;
    inFlight = (async () => {
        try {
            const release = await httpsJson(API_LATEST);
            memCache = { checkedAt: Date.now(), release, error: null };
            persistCache(memCache);
            return buildResult(release, memCache.checkedAt, null);
        } catch (e) {
            // A 404 from /releases/latest just means no release has been
            // published yet - a normal pre-1.0 state, not an error to surface.
            if (/\b404\b/.test(e.message)) {
                memCache = { checkedAt: Date.now(), release: null, error: null };
                persistCache(memCache);
                return buildResult(null, memCache.checkedAt, null);
            }
            utils.log(`⚠️ update check failed: ${e.message}`, 'warn');
            // Keep serving the last good release data, but surface the error.
            const checkedAt = memCache ? memCache.checkedAt : Date.now();
            const release = memCache ? memCache.release : null;
            return buildResult(release, checkedAt, e.message);
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

// ---------------------------------------------------------------------------
// Apply (platform self-update)
// ---------------------------------------------------------------------------

let applyState = { phase: 'idle', progress: 0, message: '', error: null, startedAt: 0 };

function getApplyState() { return { ...applyState }; }

/**
 * Apply the latest update. Windows only (others are notify-only). Prefers the
 * small app-files ZIP (extracted in place by apply-update.ps1 - no UAC); falls
 * back to the full installer when a release carries no ZIP. Either way the
 * handoff is a detached helper, since the running server is about to be torn
 * down and relaunched. Resolves as soon as that helper is launched.
 */
async function apply() {
    const result = await check({ force: true });
    const installType = result.installType;

    if (!result.updateAvailable) {
        return { ok: false, reason: 'up-to-date', installType };
    }
    if (!canSelfUpdate(installType)) {
        // Notify-only platforms get actionable instructions, not a download.
        const hint = installType === 'docker'
            ? 'Pull the new image: docker compose pull && docker compose up -d'
            : 'Update in place: git pull (or re-download) then restart the server';
        return { ok: false, reason: 'notify-only', installType, hint, latest: result.latest };
    }
    const assets = (result.latest && result.latest.assets) || {};
    if (!assets.zip && !assets.exe) {
        return { ok: false, reason: 'no-asset', installType };
    }
    if (applyState.phase === 'downloading' || applyState.phase === 'installing') {
        return { ok: true, alreadyRunning: true, state: getApplyState() };
    }

    try {
        if (assets.zip) return await applyZip(result.latest, assets.zip);
        return await applyInstaller(result.latest, assets.exe);
    } catch (e) {
        applyState.phase = 'error';
        applyState.error = e.message;
        utils.log(`❌ Update apply failed: ${e.message}`, 'error');
        return { ok: false, reason: 'apply-failed', error: e.message, installType };
    }
}

// Preferred path: download the app-files ZIP, extract it, and hand off to
// apply-update.ps1 (shipped inside the ZIP) to swap files + relaunch.
async function applyZip(latest, zipAsset) {
    const zipPath = path.join(os.tmpdir(), `eufyview-app-${latest.version}.zip`);
    const extractDir = path.join(os.tmpdir(), `eufyview-update-${latest.version}`);
    applyState = { phase: 'downloading', progress: 0, message: `Downloading ${latest.version}`, error: null, startedAt: Date.now() };

    const dl = await download(zipAsset.url, zipPath, {
        onProgress: (p) => { applyState.progress = Math.round(p * 100) / 100; }
    });
    if (zipAsset.size && Math.abs(dl.bytes - zipAsset.size) > 1024) {
        throw new Error(`size mismatch (got ${dl.bytes}, expected ${zipAsset.size})`);
    }

    // Extract with PowerShell's Expand-Archive (the ZIP is produced by
    // Compress-Archive, so this round-trips cleanly). Fresh dir each time.
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
    const unzip = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`
    ], { windowsHide: true });
    if (unzip.status !== 0) {
        throw new Error('extract failed: ' + (unzip.stderr ? unzip.stderr.toString() : 'unknown'));
    }

    const applier = path.join(extractDir, 'apply-update.ps1');
    if (!fs.existsSync(applier) || !fs.existsSync(path.join(extractDir, 'package.json'))) {
        throw new Error('extracted update is missing expected files');
    }

    applyState.phase = 'installing';
    applyState.progress = 1;
    applyState.message = 'Installing update';
    utils.log(`⬇️ Update ${latest.version} downloaded (${dl.bytes} bytes), extracted → ${extractDir}`, 'info');

    // Detached so it survives this process being killed by the applier itself.
    // Use the full powershell path (robust regardless of PATH) and DON'T pass
    // windowsHide - a detached hidden console app can fail to start; a brief
    // console flash is fine for an updater that's about to tear everything down.
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(psExe, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', applier,
        '-InstallDir', INSTALL_ROOT,
        '-SourceDir', extractDir,
        '-NodeExe', path.join(INSTALL_ROOT, 'node', 'node.exe'),
        '-TrayExe', path.join(INSTALL_ROOT, 'EufyViewTray.exe')
    ], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => utils.log(`❌ apply-update spawn failed: ${e.message}`, 'error'));
    child.unref();
    utils.log(`🚀 apply-update.ps1 launched for ${latest.version}; server will restart`, 'warn');
    return { ok: true, launched: true, method: 'zip', version: latest.version };
}

// Fallback path: run the full signed installer silently (one UAC prompt).
async function applyInstaller(latest, exeAsset) {
    const dest = path.join(os.tmpdir(), `EufyView-Setup-${latest.version}.exe`);
    applyState = { phase: 'downloading', progress: 0, message: `Downloading ${latest.version}`, error: null, startedAt: Date.now() };

    const dl = await download(exeAsset.url, dest, {
        onProgress: (p) => { applyState.progress = Math.round(p * 100) / 100; }
    });
    if (exeAsset.size && Math.abs(dl.bytes - exeAsset.size) > 1024) {
        throw new Error(`size mismatch (got ${dl.bytes}, expected ${exeAsset.size})`);
    }
    applyState.phase = 'installing';
    applyState.progress = 1;
    applyState.message = 'Launching installer';
    utils.log(`⬇️ Installer ${latest.version} downloaded (${dl.bytes} bytes) → ${dest}`, 'info');

    const child = spawn(dest, [
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
        '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS'
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    utils.log(`🚀 Installer launched for ${latest.version}; service will be replaced`, 'warn');
    return { ok: true, launched: true, method: 'installer', version: latest.version };
}

module.exports = {
    check,
    apply,
    tvInfo,
    getApplyState,
    detectInstallType,
    compareVersions,
    get currentVersion() { return CURRENT_VERSION; }
};
