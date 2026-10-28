'use strict';
// Repair HomeBase 2 "v2_eufysecurity:" images that the camera library's P2P path
// reconstructs at a FIXED 288x176 4:2:0 geometry (its sync decodeImage). Any image
// of a different true size (doorbell thumbnails are 800x608) is sheared into grey
// bands. decodeV2ImageAuto re-detects the real geometry via jpeg-js and re-splices
// a clean JPEG. Only buffers that start with that exact 288x176 reconstruction are
// touched, so ordinary JPEGs (S380, cloud, already-repaired) pass through untouched.
//
// PERFORMANCE: decodeV2ImageAuto brute-forces ~80 synchronous jpeg-js decodes to
// find the geometry, which blocks the event loop. A camera's images share one
// geometry, so we detect it ONCE per cache key (device+kind) and then use the
// instant, decode-free spliceV2Image() for every other image - turning a per-image
// CPU spike into a single one. Callers that repair many images should pass a
// stable cacheKey; without one every image pays the full detection cost.
//
// Needs eufy-security-client >=4 (ships build/http/decodeImageV2) + its optional
// jpeg-js dep. Loaded by resolved file path because the package's `exports` map
// blocks the bare subpath require. Missing deps -> input returned unchanged (no-op).

const path = require('path');

let _mod;
function v2Module() {
    if (_mod === undefined) {
        try {
            const base = path.dirname(require.resolve('eufy-security-client'));
            _mod = require(path.join(base, 'http', 'decodeImageV2.js'));
        } catch (e) { _mod = null; }
    }
    return _mod;
}

// Signature = the first 160 bytes of the standard reconstruction prefix. Those
// bytes (SOI/APP0/first DQT) are identical for every geometry and subsampling -
// buildJpegPrefix only patches the height/width (offsets 163/165) and sampling
// (169) further along - so this matches ANY v2-reconstructed image: both the
// library's raw 288x176 mis-splice AND images we already re-spliced to their true
// size on an earlier serve. Ordinary JPEGs (S380/cloud, their own quant tables)
// don't match, so they pass through untouched.
let _sig;
function v2Sig() {
    if (_sig === undefined) {
        const m = v2Module();
        try { _sig = m ? m.buildJpegPrefix(288, 176, '4:2:0').subarray(0, 160) : null; }
        catch (e) { _sig = null; }
    }
    return _sig;
}
// SOF0 frame dimensions [width, height], or null.
function sofDims(buf) {
    for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) { i++; continue; }
        const mk = buf[i + 1];
        if (mk >= 0xc0 && mk <= 0xc3) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
        if (mk === 0xd8 || mk === 0xd9 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
        i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
}

// jpeg-js (eufy-security-client >=4's optional dep) is used to undo the wash the
// v2 format leaves behind: its encrypted prefix hides the camera's real JPEG
// quantization tables, so the keyless splice substitutes standard ones and the
// whole image ends up squeezed into a narrow band around mid-grey. A per-channel
// percentile (auto-levels) stretch of the decoded pixels restores natural tone
// and colour. Loaded defensively - without jpeg-js we return the (washed) repair.
let _jpeg;
function jpegLib() {
    if (_jpeg === undefined) { try { _jpeg = require('jpeg-js'); } catch (e) { _jpeg = null; } }
    return _jpeg;
}

// Auto-levels: stretch each RGB channel's 1st..99th percentile to 0..255. Returns
// a re-encoded JPEG, or the input unchanged if jpeg-js is missing / it already has
// good dynamic range (so ordinary images passing through are never over-processed).
function stretchLevels(jpegBuf) {
    const jpeg = jpegLib();
    if (!jpeg) return jpegBuf;
    try {
        const raw = jpeg.decode(jpegBuf, { maxMemoryUsageInMB: 512, tolerantDecoding: true });
        const d = raw.data;           // RGBA
        const total = d.length / 4;
        const range = (ch) => {
            const h = new Array(256).fill(0);
            for (let i = ch; i < d.length; i += 4) h[d[i]]++;
            let c = 0, lo = 0, hi = 255;
            for (let v = 0; v < 256; v++) { c += h[v]; if (c >= total * 0.01) { lo = v; break; } }
            c = 0;
            for (let v = 255; v >= 0; v--) { c += h[v]; if (c >= total * 0.01) { hi = v; break; } }
            return [lo, hi];
        };
        const r = [range(0), range(1), range(2)];
        // Already full-range (e.g. a normal, non-washed image)? Leave it alone.
        const widest = Math.max(r[0][1] - r[0][0], r[1][1] - r[1][0], r[2][1] - r[2][0]);
        if (widest >= 200) return jpegBuf;
        for (let i = 0; i < d.length; i += 4) {
            for (let c = 0; c < 3; c++) {
                const [lo, hi] = r[c];
                let v = (d[i + c] - lo) * 255 / Math.max(1, hi - lo);
                d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
            }
        }
        return jpeg.encode({ data: d, width: raw.width, height: raw.height }, 88).data;
    } catch (e) { return jpegBuf; }
}

const geoCache = new Map();   // cacheKey -> { w, h, ss }

// Returns a clean JPEG (geometry fixed if needed, then auto-levelled), or the
// input unchanged if it isn't a v2-reconstructed image. cacheKey: a stable
// per-camera(+kind) string so true geometry is brute-forced only once per camera.
async function fixV2Thumbnail(buf, cacheKey) {
    const sig = v2Sig();
    if (!sig || !buf || buf.length < sig.length) return buf;
    if (!buf.subarray(0, sig.length).equals(sig)) return buf;   // not a v2 reconstruction
    const m = v2Module();
    if (!m) return stretchLevels(buf);

    const dims = sofDims(buf);
    const misspliced = dims && dims[0] === 288 && dims[1] === 176;   // library's fixed-geometry splice
    let repaired = buf;

    if (misspliced) {
        // Fast path: true geometry already known for this camera - splice, no decode.
        if (cacheKey && geoCache.has(cacheKey)) {
            try {
                const g = geoCache.get(cacheKey);
                const j = m.spliceV2Image(buf, g.w, g.h, g.ss);
                if (j && j.length) repaired = j;
            } catch (e) { /* fall through */ }
        }
        // Slow path: detect geometry once (brute-force jpeg-js), then cache it.
        if (repaired === buf) {
            try {
                const r = await m.decodeV2ImageAuto(buf);
                if (r && r.jpeg && r.jpeg.length && !r.lowConfidence) {
                    if (cacheKey) geoCache.set(cacheKey, { w: r.width, h: r.height, ss: r.subsampling });
                    repaired = r.jpeg;
                }
            } catch (e) { /* fall through - serve un-sheared-but-washed as last resort */ }
        }
    }
    // Already correct geometry (e.g. a prior serve wrote it back) - just re-level.
    return stretchLevels(repaired);
}

module.exports = { fixV2Thumbnail };
