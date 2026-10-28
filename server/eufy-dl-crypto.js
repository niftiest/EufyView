'use strict';
// HomeBase 2 / Chime local-recording media decryption.
//
// HB2 download frames are NOT RSA-wrapped (the cloud cipher's `private_key`).
// Each keyframe carries a 129-byte ECIES envelope sealed to the cipher's
// `ecc_private_key` (a 32-byte P-256 scalar from cloud get_ciphers); unwrapping
// it yields a 32-byte media key, and the frame body is AES-256-GCM under it.
// Protocol reverse-engineered by mega-yfue/eufy-sdk PR #260 (tested on a T8010
// station). eufyKDF matches eufy-security-client 4.2.0 byte-for-byte.
//
// See the README (Credits & References) for the source of this scheme.

const { createHmac, createECDH, createDecipheriv, createHash } = require('crypto');

const GCM_AAD = Buffer.from('eufy security');

// HMAC-SHA256 feedback KDF, label "ECIES", 48-byte output.
// Verbatim from eufy-security-client 4.2.0 p2p/utils.js `eufyKDF`.
function eufyKDF(key) {
    const hashLen = 32;
    const digestLen = 48;
    const staticBuffer = Buffer.from('ECIES');
    const steps = Math.ceil(digestLen / hashLen);
    const out = Buffer.alloc(hashLen * steps);
    let tmp = staticBuffer;
    for (let step = 0; step < steps; ++step) {
        tmp = createHmac('sha256', key).update(tmp).digest();
        const digest = createHmac('sha256', key)
            .update(Buffer.concat([tmp, staticBuffer]))
            .digest();
        digest.copy(out, hashLen * step);
    }
    return out.subarray(0, digestLen);
}

// Strip PKCS#7 padding (block size 16). Returns the slice without padding, or
// the input unchanged if the padding byte is out of range (defensive).
function stripPkcs7(buf) {
    if (buf.length === 0) return buf;
    const pad = buf[buf.length - 1];
    if (pad < 1 || pad > 16 || pad > buf.length) return buf;
    for (let i = buf.length - pad; i < buf.length; i++) {
        if (buf[i] !== pad) return buf; // not valid padding, leave as-is
    }
    return buf.subarray(0, buf.length - pad);
}

// Unwrap a 129-byte ECIES envelope -> 32-byte media key.
// Layout: ephPub(33, compressed) | iv(16) | ct(48) | mac(32).
// eccPrivateKey: 32-byte P-256 private scalar (hex string or Buffer).
// Throws on bad length or MAC mismatch.
function eciesUnwrap(envelope, eccPrivateKey) {
    if (envelope.length < 129) {
        throw new Error(`ECIES envelope too short: ${envelope.length} (need >=129)`);
    }
    const ephPub = envelope.subarray(0, 33);
    const iv = envelope.subarray(33, 49);
    const ct = envelope.subarray(49, 97);
    const mac = envelope.subarray(97, 129);

    const priv = Buffer.isBuffer(eccPrivateKey)
        ? eccPrivateKey
        : Buffer.from(eccPrivateKey, 'hex');
    if (priv.length !== 32) {
        throw new Error(`ecc_private_key must be 32 bytes, got ${priv.length}`);
    }

    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(priv);
    const shared = ecdh.computeSecret(ephPub); // P-256 x-coordinate, 32 bytes

    const kdf = eufyKDF(shared);
    const aesKey = kdf.subarray(0, 16);
    const macKey = kdf.subarray(16, 48);

    const expectMac = createHmac('sha256', macKey)
        .update(Buffer.concat([iv, ct]))
        .digest();
    if (!expectMac.equals(mac)) {
        throw new Error('ECIES MAC mismatch (wrong ecc_private_key or corrupt envelope)');
    }

    const decipher = createDecipheriv('aes-128-cbc', aesKey, iv);
    decipher.setAutoPadding(false);
    const padded = Buffer.concat([decipher.update(ct), decipher.final()]);
    const mediaKey = stripPkcs7(padded);
    if (mediaKey.length !== 32) {
        throw new Error(`unwrapped media key is ${mediaKey.length} bytes, expected 32`);
    }
    return mediaKey;
}

// AES-256-GCM decrypt a frame body. nonce(12) tag(16) ct(N) with AAD "eufy security".
function gcmDecrypt(mediaKey, nonce, tag, ciphertext) {
    const decipher = createDecipheriv('aes-256-gcm', mediaKey, nonce);
    decipher.setAAD(GCM_AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// Decode a full keyframe payload (the decrypted XZYH data message body, i.e.
// starting at the 22-byte video header). Returns { mediaKey, video }.
// Layout: header(22) | envelope(129) | gcmTag(16) | nonce(12) | ct(...)
function decodeKeyframe(payload, eccPrivateKey) {
    const envelope = payload.subarray(22, 22 + 129);
    const mediaKey = eciesUnwrap(envelope, eccPrivateKey);
    const tag = payload.subarray(151, 167);
    const nonce = payload.subarray(167, 179);
    const ct = payload.subarray(179);
    const video = gcmDecrypt(mediaKey, nonce, tag, ct);
    return { mediaKey, video };
}

// Decode an audio frame (cmd 1301). Layout: header(16: u32@0 len, u8@5 codec) |
// tag(16) | nonce(12) | ct(...). key = media key from most recent keyframe.
function decodeAudio(payload, mediaKey) {
    const codec = payload[5];
    const tag = payload.subarray(16, 32);
    const nonce = payload.subarray(32, 44);
    const ct = payload.subarray(44);
    const audio = gcmDecrypt(mediaKey, nonce, tag, ct);
    return { codec, audio };
}

// ---------------------------------------------------------------------------
// Chime-paired doorbell clips (e.g. a battery doorbell on a T8020 Chime station).
// These are NOT ECIES and NOT wrapped with a cloud cipher. The whole keyframe body
// is AES-128-ECB (no padding) under a media key derived purely from device info -
// the eufy-security-client getImageKey(serial, p2pDid, rand) algorithm (the USENIX
// WOOT'24 paper's create_pic_code_v1 / "media key" scheme), here applied to the
// whole video body instead of just an image header. `rand` is the "01"+digits
// string the hub returns in the CMD_DOWNLOAD_VIDEO result. Inter-frames (signCode 0)
// are plaintext. See the README (Credits & References) for the source of this scheme.
// getImageKey below is a byte-exact port of the library's http/utils.js (verified).

function _idSuffix(p2pDid) {
    const m = String(p2pDid).match(/^[A-Z]+-(\d+)-[A-Z]+$/);
    if (!m) return 0;
    const d = m[1];
    const n1 = parseInt(d[0], 10), n2 = parseInt(d[1], 10), n3 = parseInt(d[3], 10), n4 = parseInt(d[5], 10);
    let r = n1 + n2 + n3;
    if (n3 < 5) r += n3;
    return r + n4;
}
function _imageBaseCode(serial, p2pDid) {
    let nr = parseInt(`0x${serial[serial.length - 1]}`);
    nr = (nr + 10) % 10;
    return `${serial.substring(nr)}${_idSuffix(p2pDid)}`;
}
function _imageSeed(p2pDid, code) {
    const nCode = parseInt(String(code).substring(2), 10);
    const prefix = 1000 - _idSuffix(p2pDid);
    return createHash('md5').update(`${prefix}${nCode}`).digest('hex').toUpperCase();
}
function getImageKey(serial, p2pDid, code) {
    const baseCode = _imageBaseCode(serial, p2pDid);
    const seed = _imageSeed(p2pDid, code);
    const hash = createHash('sha256').update(`01${baseCode}${seed}`).digest('hex');
    const hashBytes = [...Buffer.from(hash, 'hex')];
    const startByte = hashBytes[10];
    for (let i = 0; i < 32; i++) {
        const byte = hashBytes[i];
        let fixed_byte = startByte;
        if (i < 31) fixed_byte = hashBytes[i + 1];
        if (i === 31 || (i & 1) !== 0) {
            hashBytes[10] = fixed_byte;
            if (126 < byte || 126 < hashBytes[10]) {
                if (byte < hashBytes[10] || byte - hashBytes[10] === 0) hashBytes[i] = hashBytes[10] - byte;
                else hashBytes[i] = byte - hashBytes[10];
            }
        } else if (byte < 125 || fixed_byte < 125) {
            hashBytes[i] = fixed_byte + byte;
        }
    }
    return Buffer.from(hashBytes.slice(16)).toString('hex').toUpperCase();
}

// The 16-byte AES-128 media key = first 16 ASCII chars of getImageKey(...).
function chimeMediaKey(stationSerial, p2pDid, rand) {
    return Buffer.from(getImageKey(stationSerial, p2pDid, rand), 'utf-8').subarray(0, 16);
}

// Only the FIRST 128 bytes of a media body are AES-128-ECB encrypted; the rest is
// plaintext (the same partial-encryption the camera library uses for the RSA path,
// and the image scheme uses for the 256-byte JFIF header). Verified: decrypting the
// whole body shears the H.264 slice after ~128 bytes ("top block unavailable"); the
// 128-only variant decodes cleanly in FFmpeg.
const CHIME_ENC_BYTES = 128;
function chimeDecryptBody(body, key) {
    const n = body.length >= CHIME_ENC_BYTES ? CHIME_ENC_BYTES : body.length - (body.length % 16);
    if (n <= 0) return body;
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(false);
    const head = Buffer.concat([decipher.update(body.subarray(0, n)), decipher.final()]);
    return Buffer.concat([head, body.subarray(n)]);
}

// Decode a Chime keyframe. payload = the video data message (22-byte header + body).
// Returns the decrypted H.264 (SPS|PPS|IDR), videoDataLength bytes.
function decodeChimeKeyframe(payload, stationSerial, p2pDid, rand) {
    const dataLen = payload.readUInt32LE(0);
    const body = payload.subarray(22, 22 + dataLen);
    return chimeDecryptBody(body, chimeMediaKey(stationSerial, p2pDid, rand));
}

// NOTE: Chime download AUDIO is PLAINTEXT AAC (verified - it muxes cleanly as-is),
// unlike HB2's GCM audio. Only the video keyframes' first 128 bytes are encrypted.
// So there's no decodeChimeAudio: the session.js audio path passes it through.

module.exports = {
    GCM_AAD,
    eufyKDF,
    eciesUnwrap,
    gcmDecrypt,
    decodeKeyframe,
    decodeAudio,
    stripPkcs7,
    getImageKey,
    chimeMediaKey,
    decodeChimeKeyframe,
};
