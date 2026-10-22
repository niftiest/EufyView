/**
 * Video Transcoding Module
 * 
 * Handles real-time video transcoding from Eufy devices:
 * - H.264/H.265 to H.264 conversion via FFmpeg
 * - fMP4 container for HTTP streaming
 * - Init segment management for fragmented MP4
 * - Keyframe detection and snapshot extraction
 * - Low-latency streaming optimization
 */

const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');

// Allow configuring FFmpeg path (for portable/local installs)
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const eventEmitter = require('events');

const utils = require('./utils');

// Environment configuration
const LOGGINGLEVEL = process.env.LOGGINGLEVEL || '2';
const FFMPEG_MINLOGLEVEL = process.env.FFMPEG_MINLOGLEVEL || 'warning';

const ev = new eventEmitter();

// Transcoding state
let CONFIG = utils.loadConfig();
let ffmpegProcess = null;              // FFmpeg process instance
let inputStream = null;                // Video input stream (H.264/H.265)
let aacInputStream = null;             // Audio input stream (AAC)
let outputStream = null;               // fMP4 output stream
let isTranscoding = false;             // Transcoding active flag
let videoMetadata = null;              // Video codec, resolution, FPS
let audioMetadata = null;              // Audio codec info
let currentDevice = 'unknown';         // Currently streaming device serial

// fMP4 segment management
let initSegment = null;                // fMP4 init segment (ftyp + moov)
let isCapturingInit = true;            // Flag for init segment capture
let lastKeyframeSegment = null;        // Latest keyframe segment (moof + mdat)

// Snapshot management
let lastSnapshotBuffer = null;         // In-memory snapshot buffer
let segmentCounter = 0;                // Segment counter for keyframe detection
let snapshotSaveSeq = 0;               // Unique temp name per save (saves can overlap)
let segmentSizes = [];                 // Track segment sizes for adaptive threshold
let largestSegmentSize = 0;            // Largest segment size seen

// Frame view (Data Saver) state — low-bandwidth MJPEG path
let frameMode = false;                 // When true, decode to JPEG frames instead of fMP4
let mjpegProcess = null;               // Dedicated FFmpeg producing MJPEG
let mjpegInputStream = null;           // H.264/H.265 input for the MJPEG encoder
let mjpegBuffer = Buffer.alloc(0);     // Accumulator for parsing JPEG frame boundaries
let latestFrame = null;                // Most recent complete JPEG frame (Buffer)
let frameSeq = 0;                      // Increments per new frame — used as ETag

// JPEG markers for frame boundary detection in the MJPEG stream
const JPEG_SOI = Buffer.from([0xFF, 0xD8]); // Start of Image
const JPEG_EOI = Buffer.from([0xFF, 0xD9]); // End of Image

function initTranscode() {
    CONFIG = utils.loadConfig();
    utils.log('🎬 Transcode module initialized', 'info');
}

/**
 * Handle Video Data
 * Receives H.264/H.265 video data from Eufy device and forwards to FFmpeg
 * Stores metadata on first frame and starts transcoding if needed
 * @param {Buffer} buffer - Video data buffer
 * @param {Object} metadata - Video metadata (codec, resolution, FPS)
 */
function handleVideoData(buffer, metadata) {
    utils.log(`📹 Video chunk received - Size: ${buffer.length} bytes`, 'trace');

    // Store metadata on first frame received
    if (!videoMetadata && metadata) {
        videoMetadata = metadata;
        utils.log(`📹 Video: ${metadata.videoCodec} ${metadata.videoWidth}x${metadata.videoHeight} @ ${metadata.videoFPS}fps`, 'info');
    } else if (metadata && (videoMetadata.videoWidth !== metadata.videoWidth || videoMetadata.videoHeight !== metadata.videoHeight)) {
        // Resolution changed mid-stream!
        utils.log(`🔄 Video resolution changed: ${videoMetadata.videoWidth}x${videoMetadata.videoHeight} => ${metadata.videoWidth}x${metadata.videoHeight}`, 'warn');
        videoMetadata = metadata;
    }

    // Data Saver path: feed the MJPEG encoder only — skip the heavier fMP4 pipeline
    if (frameMode) {
        if (!mjpegProcess) startMjpegEncoder(metadata);
        if (mjpegInputStream && buffer) {
            try {
                mjpegInputStream.write(buffer);
            } catch (e) {
                utils.log(`MJPEG stream write error: ${e}`, 'error');
            }
        }
        return;
    }

    // Initialize transcoding on first video data
    if (!isTranscoding) {
        startTranscoding();
    }

    // Forward H.264/H.265 data to FFmpeg input stream
    if (inputStream && buffer) {
        try {
            inputStream.write(buffer);
        } catch (e) {
            utils.log(`Video stream write error: ${e}`, 'error');
        }
    }
}

/**
 * Handle Audio Data
 * Receives AAC audio data from Eufy device and forwards to FFmpeg
 * Stores metadata on first audio frame and starts transcoding if needed
 * @param {Buffer} buffer - Audio data buffer
 * @param {Object} metadata - Audio metadata (codec)
 */
function handleAudioData(buffer, metadata) {
    // Frame view is video-only — ignore audio entirely
    if (frameMode) return;

    utils.log(`🎵 Audio chunk received - Size: ${buffer.length} bytes`, 'trace');

    // Store metadata on first audio frame received
    if (!audioMetadata && metadata) {
        audioMetadata = metadata;
        utils.log(`🔊 Audio: ${metadata.audioCodec}`, 'info');
    }

    // Initialize transcoding on first audio data
    if (!isTranscoding) {
        startTranscoding();
    }

    // Forward AAC data to FFmpeg audio input stream
    if (aacInputStream && buffer) {
        try {
            aacInputStream.write(buffer);
        } catch (e) {
            utils.log(`Audio stream write error: ${e}`, 'error');
        }
    }
}

/**
 * Start Transcoding
 * Initializes FFmpeg process with optimized settings for low-latency streaming
 * Sets up input/output streams and MP4 box parsing for fMP4 segments
 */
function startTranscoding() {
    // Prevent duplicate transcoding processes
    if (isTranscoding) return;

    // Require video metadata before starting
    if (!videoMetadata || !videoMetadata.videoCodec) {
        utils.log('❌ Cannot start transcoding - missing video metadata', 'warn');
        return;
    }

    utils.log('🎬 Starting ffmpeg transcoding...', 'debug');
    isTranscoding = true;

    // Reset segment tracking for new transcoding session
    initSegment = null;
    isCapturingInit = true;
    lastKeyframeSegment = null;
    lastSnapshotBuffer = null;
    segmentCounter = 0;
    segmentSizes = [];
    largestSegmentSize = 0;

    // Create pass-through streams for FFmpeg
    inputStream = new PassThrough();        // Video input
    aacInputStream = new PassThrough();     // Audio input
    outputStream = new PassThrough();       // fMP4 output

    /**
     * FFmpeg Arguments
     * Configured for low-latency live streaming with fMP4 output
     */
    const ffmpegArgs = [
        // Logging level (conditional debug output)
        ...(LOGGINGLEVEL > 2 ? ['-loglevel', 'debug', '-report'] : ['-loglevel', FFMPEG_MINLOGLEVEL]),

        // Video input configuration (pipe:0 = stdin)
        '-f', (videoMetadata.videoCodec === 'H264' ? 'h264' : 'hevc'),  // Input format
        '-flags', '+bsf_extract',          // Extract bitstream
        '-fflags', 'nobuffer+discardcorrupt',  // Low latency flags
        '-flags', 'low_delay',             // Minimize buffering
        '-probesize', '32',                // Minimal probing for faster startup
        '-analyzeduration', '0',           // No analysis delay
        '-i', 'pipe:0',                    // Read from stdin
        '-thread_queue_size', '512',       // Input thread queue size

        // Audio input configuration (pipe:3 = file descriptor 3)
        '-f', 'aac',                       // AAC audio format
        '-fflags', 'nobuffer',             // Low latency
        '-i', 'pipe:3',                    // Read from fd 3
        '-thread_queue_size', '512',       // Input thread queue size

        // Map both inputs to output
        '-map', '0:v',                     // Video from first input
        '-map', '1:a',                     // Audio from second input

        // Video encoding settings - optimized for low-latency streaming
        '-c:v', 'libx264',                 // H.264 encoder
        ...(CONFIG.VIDEO_SCALE ? ['-vf', `scale=${CONFIG.VIDEO_SCALE}`] : []),  // Optional scaling
        '-preset', CONFIG.TRANSCODING_PRESET,  // Encoding speed preset
        '-tune', 'zerolatency',            // Zero-latency tuning
        '-crf', CONFIG.TRANSCODING_CRF,    // Constant Rate Factor (quality)
        '-profile:v', 'main',              // H.264 profile
        '-level', '3.1',                   // H.264 level
        '-g', CONFIG.FFMPEG_SHORT_KEYFRAMES ? '15' : '30',  // GOP size (keyframe interval)
        '-keyint_min', CONFIG.FFMPEG_SHORT_KEYFRAMES ? '15' : '30',
        '-sc_threshold', '0',              // Disable scene change detection
        '-pix_fmt', 'yuv420p',             // Pixel format for compatibility
        '-x264-params', 'nal-hrd=cbr:force-cfr=1',  // CBR for consistent bitrate

        // Audio encoding settings
        '-c:a', 'aac',                     // AAC audio codec
        '-ac', '1',                        // Mono audio

        // fMP4 container configuration for live streaming
        '-f', 'mp4',                       // MP4 container
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',  // Fragmented MP4
        '-frag_duration', CONFIG.FFMPEG_SHORT_KEYFRAMES ? '500000' : '1000000',  // Fragment duration
        '-min_frag_duration', CONFIG.FFMPEG_SHORT_KEYFRAMES ? '500000' : '1000000',
        '-muxdelay', '0',                  // No mux delay
        '-muxpreload', '0',                // No preload

        '-threads', CONFIG.FFMPEG_THREADS, // Encoding threads

        'pipe:1'                           // Output to stdout
    ];

    // Spawn FFmpeg process with 4 file descriptors
    // stdio[0] = stdin (video), stdio[1] = stdout (output), stdio[2] = stderr, stdio[3] = audio
    ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    });

    // Connect video stream to stdin (pipe:0)
    inputStream.pipe(ffmpegProcess.stdio[0]);

    // Connect audio stream to file descriptor 3 (pipe:3)
    aacInputStream.pipe(ffmpegProcess.stdio[3]);

    /**
     * MP4 Box Parsing
     * Parse stdout to extract fMP4 boxes (ftyp, moov, moof, mdat)
     * Handles init segment capture and keyframe detection
     */
    let chunkBuffer = Buffer.alloc(0);

    ffmpegProcess.stdout.on('data', (chunk) => {
        utils.log(`📦 ffmpeg output chunk received - Size: ${chunk.length} bytes`, 'trace');

        // Accumulate incoming data
        chunkBuffer = Buffer.concat([chunkBuffer, chunk]);

        // Process all complete MP4 boxes in buffer
        while (chunkBuffer.length >= 8) {  // Minimum box header size
            const boxSize = chunkBuffer.readUInt32BE(0);     // Read box size (4 bytes)
            const boxType = chunkBuffer.slice(4, 8).toString('ascii');  // Read box type (4 bytes)

            // Wait for more data if box is incomplete
            if (chunkBuffer.length < boxSize) {
                break;
            }

            // Extract complete box and update buffer
            const box = chunkBuffer.slice(0, boxSize);
            chunkBuffer = chunkBuffer.slice(boxSize);

            /**
             * Init Segment Capture
             * Capture ftyp and moov boxes to build init segment
             * Init segment is required before streaming any media data
             */
            if (isCapturingInit) {
                if (boxType === 'ftyp') {
                    initSegment = box; // Start with ftyp
                    utils.log(`📦 Captured ftyp box: ${boxSize} bytes`, 'debug');
                } else if (boxType === 'moov' && initSegment) {
                    initSegment = Buffer.concat([initSegment, box]); // Add moov
                    isCapturingInit = false;
                    utils.log(`✅ Init segment complete: ${initSegment.length} bytes (ftyp + moov)`, 'info');

                    // Send to all clients waiting for init
                    utils.getActiveStreamClients().forEach(client => {
                        if (client.active && !client.hasReceivedInit && !client.response.writableEnded) {
                            try {
                                client.response.write(initSegment);
                                client.hasReceivedInit = true;
                                utils.log(`📤 Sent init to client`, 'debug');
                            } catch (e) {
                                utils.log(`Init segment send error: ${e}`, 'error');
                                client.active = false;
                            }
                        }
                    });
                }
            } else {
                /**
                 * Media Segment Processing
                 * After init segment: process moof/mdat boxes for keyframe detection
                 * Forward all boxes to output stream for live playback
                 */

                // Capture keyframe segments for snapshot generation
                captureSnapshot(boxType, box);

                // Forward media data to all active streaming clients
                outputStream.write(box);
            }
        }
    });

    /**
     * FFmpeg Error Output Handler
     * Logs FFmpeg stderr for debugging
     */
    ffmpegProcess.stderr.on('data', (data) => {
        const line = data.toString();
        if (line.includes('frame=') || line.includes('speed=')) {
            utils.log(`ffmpeg: ${line.trim()}`, 'debug');
        }
    });

    /**
     * FFmpeg Error Handler
     * Logs errors and stops transcoding on failure
     */
    ffmpegProcess.on('error', (err) => {
        utils.log(`❌ ffmpeg error: ${err}`, 'error');
        currentDevice = 'unknown';
        stopTranscoding();
    });

    /**
     * FFmpeg Exit Handler
     * Saves final snapshot to disk when stream ends
     * Cleans up transcoding state
     */
    ffmpegProcess.on('close', (code) => {
        utils.log(`ℹ️ ffmpeg exited with code ${code}`, 'info');

        // Save final snapshot before cleanup
        if (lastSnapshotBuffer && currentDevice && currentDevice !== 'unknown') {
            saveSnapshotToDisk();
        }

        // Reset state
        currentDevice = 'unknown';
        lastSnapshotBuffer = null;
        stopTranscoding();
    });

    utils.log('✅ ffmpeg ready', 'info');
}

/**
 * Stop Transcoding
 * Gracefully stops FFmpeg process and cleans up all resources
 * Closes active client connections and resets state
 */
function stopTranscoding() {
    if (!isTranscoding) return;

    utils.log('ℹ️ Stopping transcoding...', 'debug');

    // Close all active HTTP streaming clients
    utils.getActiveStreamClients().forEach(client => {
        if (client.active && !client.response.writableEnded) {
            try {
                client.response.end();
            } catch (e) {
                // Ignore errors during cleanup
            }
        }
    });
    utils.clearActiveStreamClients();

    // Terminate FFmpeg process
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
        ffmpegProcess = null;
    }

    // Close and cleanup all streams
    if (inputStream) {
        inputStream.end();
        inputStream = null;
    }

    if (aacInputStream) {
        aacInputStream.end();
        aacInputStream = null;
    }

    if (outputStream) {
        outputStream.end();
        outputStream = null;
    }

    // Reset state variables
    isTranscoding = false;
    videoMetadata = null;
    audioMetadata = null;
    initSegment = null;
    lastKeyframeSegment = null;
}

/**
 * Clear Metadata
 * Resets video and audio metadata (used when restarting stream)
 */
function clearMetadata() {
    videoMetadata = null;
    audioMetadata = null;
}

/**
 * Fragment Has Keyframe
 * Reads the video samples' flags from a moof box (ISO 14496-12): per-sample
 * flags when present (any keyframe counts), else trun first_sample_flags,
 * else tfhd default flags. A sample is a keyframe when its
 * sample_is_non_sync_sample bit is clear.
 * Only the video track (track 1 — mapped first in the FFmpeg args) counts.
 * @param {Buffer} moof - moof box (anything after it is ignored)
 * @returns {boolean|null} null when the flags can't be read
 */
function fragmentHasKeyframe(moof) {
    const NON_SYNC = 0x00010000;
    try {
        if (moof.toString('ascii', 4, 8) !== 'moof') return null;
        const end = moof.readUInt32BE(0);
        for (let off = 8; off + 8 <= end;) {
            const size = moof.readUInt32BE(off);
            if (size < 8) return null;
            if (moof.toString('ascii', off + 4, off + 8) === 'traf') {
                let trackId = null, defaultFlags = null;
                for (let p = off + 8; p + 8 <= off + size;) {
                    const bsize = moof.readUInt32BE(p);
                    if (bsize < 8) return null;
                    const type = moof.toString('ascii', p + 4, p + 8);
                    const flags = moof.readUInt32BE(p + 8) & 0xffffff;
                    if (type === 'tfhd') {
                        trackId = moof.readUInt32BE(p + 12);
                        let q = p + 16;
                        if (flags & 0x01) q += 8;   // base_data_offset
                        if (flags & 0x02) q += 4;   // sample_description_index
                        if (flags & 0x08) q += 4;   // default_sample_duration
                        if (flags & 0x10) q += 4;   // default_sample_size
                        if (flags & 0x20) defaultFlags = moof.readUInt32BE(q);
                    } else if (type === 'trun' && trackId === 1) {
                        const count = moof.readUInt32BE(p + 12);
                        let q = p + 16;
                        if (flags & 0x01) q += 4;   // data_offset
                        let firstFlags = null;
                        if (flags & 0x04) { firstFlags = moof.readUInt32BE(q); q += 4; }
                        if (flags & 0x400) {
                            // Per-sample flags: a keyframe anywhere in the fragment will do
                            // (FFmpeg skips undecodable frames before it)
                            const stride = 4 * (1 + !!(flags & 0x100) + !!(flags & 0x200) + !!(flags & 0x800));
                            const flagsAt = q + (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0);
                            for (let i = 0; i < count; i++) {
                                if ((moof.readUInt32BE(flagsAt + i * stride) & NON_SYNC) === 0) return true;
                            }
                            return false;
                        }
                        const sampleFlags = firstFlags !== null ? firstFlags : defaultFlags;
                        return sampleFlags === null ? null : (sampleFlags & NON_SYNC) === 0;
                    }
                    p += bsize;
                }
            }
            off += size;
        }
    } catch (e) { /* truncated box */ }
    return null;
}

/**
 * Capture Snapshot
 * Detects keyframe segments (moof + mdat pairs) using adaptive size thresholding
 * Stores complete keyframe segments for snapshot extraction
 * @param {string} boxType - MP4 box type ('moof' or 'mdat')
 * @param {Buffer} box - MP4 box data
 */
function captureSnapshot(boxType, box) {
    if (boxType === 'moof') {
        // Start collecting new segment (moof header)
        lastKeyframeSegment = box;
        segmentCounter++;
    } else if (boxType === 'mdat' && lastKeyframeSegment) {
        // Complete segment by adding mdat (media data)
        lastKeyframeSegment = Buffer.concat([lastKeyframeSegment, box]);
        const segmentSize = lastKeyframeSegment.length;

        // Track segment sizes for adaptive keyframe detection
        segmentSizes.push(segmentSize);
        if (segmentSizes.length > 20) segmentSizes.shift();  // Keep sliding window of last 20

        // Update largest segment size seen
        if (segmentSize > largestSegmentSize) {
            largestSegmentSize = segmentSize;
        }

        /**
         * Keyframe Detection
         * Preferred: read the fragment's own sample flags (moof → trun). Size
         * alone is unreliable — a busy scene can produce P-frame fragments
         * bigger than the keyframe ones, and those decode to nothing.
         * Fallback (flags unreadable): adaptive size threshold —
         * fixed 300KB at first, then 70% of the largest segment.
         */
        let isLikelyKeyframe = fragmentHasKeyframe(lastKeyframeSegment);
        if (isLikelyKeyframe !== null) {
            // flags were readable — nothing more to decide
        } else if (segmentSizes.length < 5) {
            // Initial phase: simple threshold (300KB minimum)
            isLikelyKeyframe = segmentSize > 300000;
        } else {
            // Adaptive phase: keyframe is 70%+ of largest segment
            const threshold = largestSegmentSize * 0.7;
            isLikelyKeyframe = segmentSize >= threshold;
        }

        if (isLikelyKeyframe) {
            utils.log(`🔑 Keyframe segment #${segmentCounter}: ${segmentSize} bytes (threshold: ${segmentSizes.length < 5 ? '300KB' : Math.round(largestSegmentSize * 0.7 / 1024) + 'KB'})`, 'debug');

            // Store keyframe segment with init segment for complete playable snapshot
            lastSnapshotBuffer = Buffer.concat([initSegment, lastKeyframeSegment]);
        } else {
            utils.log(`⏭️ Skipping small segment #${segmentCounter}: ${segmentSize} bytes`, 'debug');
        }
    }
}

/**
 * Save Snapshot to Disk
 * Extracts first frame from fMP4 buffer and saves as JPEG
 * Uses FFmpeg to decode video and extract single frame
 * Emits 'snapshotSaved' event on success
 */
function saveSnapshotToDisk() {
    // Validate prerequisites
    if (!lastSnapshotBuffer || !currentDevice || currentDevice === 'unknown') {
        utils.log('⚠️ Cannot save snapshot - no buffer or device name', 'warn');
        return;
    }

    const snapshotPath = path.join(utils.snapshotDir, `${currentDevice}.jpg`);
    const tmpPath = path.join(utils.snapshotDir, `${currentDevice}.${++snapshotSaveSeq}.tmp.jpg`);

    // Ensure snapshots directory exists
    if (!fs.existsSync(utils.snapshotDir)) {
        fs.mkdirSync(utils.snapshotDir, { recursive: true });
    }

    try {
        // Store device SN for async callback
        const deviceSN = currentDevice;

        /**
         * FFmpeg Snapshot Extraction
         * Decodes fMP4 buffer and extracts first frame as high-quality JPEG.
         * Written to a temp file first: FFmpeg exits 0 even when it decoded
         * nothing, so success is only claimed once a real image exists.
         */
        const ffmpeg = spawn(FFMPEG_PATH, [
            '-y',                           // Overwrite output file
            '-f', 'mp4',                    // Input format
            '-i', 'pipe:0',                 // Read from stdin
            '-vframes', '1',                // Extract only first frame
            '-pix_fmt', 'yuvj420p',         // Full-range YUV for JPEG
            '-q:v', '2',                    // High quality JPEG (2-5 is best)
            '-update', '1',                 // Single image, not a sequence
            tmpPath
        ]);

        // Write fMP4 buffer to FFmpeg stdin
        ffmpeg.stdin.write(lastSnapshotBuffer, (err) => {
            if (err) {
                utils.log(`⚠️ Error writing to FFmpeg stdin: ${err}`, 'warn');
            }
            ffmpeg.stdin.end();
        });

        // Keep FFmpeg's output for the failure log
        let stderrTail = '';
        ffmpeg.stderr.on('data', (data) => {
            utils.log(`FFmpeg snapshot: ${data.toString().trim()}`, 'debug');
            stderrTail = (stderrTail + data.toString()).slice(-300);
        });

        // Handle snapshot extraction result
        ffmpeg.on('close', (code) => {
            let size = 0;
            try { size = fs.statSync(tmpPath).size; } catch (e) { /* not written */ }
            if (code === 0 && size > 0) {
                try {
                    fs.renameSync(tmpPath, snapshotPath);
                } catch (err) {
                    utils.log(`❌ Snapshot rename failed: ${err.message}`, 'error');
                    ev.emit('snapshotFailed', deviceSN);
                    return;
                }
                utils.log(`✅ Snapshot saved to disk: ${snapshotPath}`, 'debug');
                // Update snapshot timestamp and emit event
                utils.saveSnapshotDatetime(deviceSN);
                ev.emit('snapshotSaved', deviceSN);
            } else {
                try { fs.unlinkSync(tmpPath); } catch (e) { /* not there */ }
                utils.log(`❌ Snapshot save failed for ${deviceSN} (code ${code}, ${size} bytes): ${stderrTail.trim()}`, 'warn');
                ev.emit('snapshotFailed', deviceSN);
            }
        });

        // Handle FFmpeg errors
        ffmpeg.on('error', (err) => {
            utils.log(`❌ Snapshot save error: ${err}`, 'error');
            ev.emit('snapshotFailed', deviceSN);
        });
    } catch (err) {
        utils.log(`❌ Snapshot write error: ${err}`, 'error');
    }
}

/**
 * Get Latest Snapshot
 * Returns in-memory snapshot buffer for live preview
 * @returns {Buffer|null} fMP4 snapshot buffer or null
 */
function getLatestSnapshot() {
    return lastSnapshotBuffer;
}

// ============================================================================
// Frame View (Data Saver) — low-bandwidth MJPEG path
// ============================================================================

/**
 * Start Frame Mode
 * Switches the transcoder into Data Saver mode: incoming video is decoded to
 * low-fps JPEG frames instead of an fMP4 stream. The fMP4 pipeline is torn down.
 * The actual MJPEG encoder spawns lazily once the first video chunk (with codec
 * metadata) arrives.
 */
function startFrameMode() {
    if (frameMode) return;

    // Tear down any active fMP4 streaming first (mutually exclusive)
    stopTranscoding();

    CONFIG = utils.loadConfig();  // pick up latest FRAME_* settings
    frameMode = true;
    latestFrame = null;
    mjpegBuffer = Buffer.alloc(0);
    utils.log('🖼️ Frame mode (Data Saver) started', 'info');
}

/**
 * Stop Frame Mode
 * Kills the MJPEG encoder and clears frame state.
 */
function stopFrameMode() {
    if (!frameMode && !mjpegProcess) return;

    frameMode = false;

    if (mjpegProcess) {
        try { mjpegProcess.kill('SIGKILL'); } catch (e) { /* ignore */ }
        mjpegProcess = null;
    }
    if (mjpegInputStream) {
        try { mjpegInputStream.end(); } catch (e) { /* ignore */ }
        mjpegInputStream = null;
    }
    latestFrame = null;
    mjpegBuffer = Buffer.alloc(0);
    utils.log('🖼️ Frame mode (Data Saver) stopped', 'debug');
}

/**
 * Start MJPEG Encoder
 * Spawns an FFmpeg process that decodes the raw H.264/H.265 input and emits a
 * low-fps, scaled MJPEG stream. Output is parsed into individual JPEG frames.
 * @param {Object} metadata - Video metadata (used to pick h264 vs hevc input)
 */
function startMjpegEncoder(metadata) {
    if (mjpegProcess) return;

    const inputFormat = (metadata && metadata.videoCodec === 'H265') ? 'hevc' : 'h264';
    const fps = CONFIG.FRAME_FPS || '2';
    const scale = CONFIG.FRAME_SCALE || '640:-2';
    const quality = CONFIG.FRAME_QUALITY || '7';

    mjpegInputStream = new PassThrough();

    const args = [
        '-loglevel', FFMPEG_MINLOGLEVEL,
        '-f', inputFormat,
        '-fflags', 'nobuffer+discardcorrupt',
        '-flags', 'low_delay',
        '-probesize', '32',
        '-analyzeduration', '0',
        '-i', 'pipe:0',
        '-an',                              // no audio
        '-vf', `fps=${fps},scale=${scale}`, // low frame rate + downscale
        '-f', 'mjpeg',
        '-q:v', String(quality),
        'pipe:1'
    ];

    utils.log(`🖼️ Starting MJPEG encoder (${inputFormat} -> ${fps}fps ${scale} q${quality})`, 'info');
    mjpegProcess = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    mjpegInputStream.pipe(mjpegProcess.stdio[0]);

    mjpegProcess.stdout.on('data', (chunk) => {
        mjpegBuffer = Buffer.concat([mjpegBuffer, chunk]);
        extractJpegFrames();
    });

    mjpegProcess.stderr.on('data', (data) => {
        utils.log(`MJPEG ffmpeg: ${data.toString().trim()}`, 'trace');
    });

    mjpegProcess.on('error', (err) => {
        utils.log(`❌ MJPEG ffmpeg error: ${err}`, 'error');
        mjpegProcess = null;
    });

    mjpegProcess.on('close', (code) => {
        utils.log(`ℹ️ MJPEG ffmpeg exited with code ${code}`, 'debug');
        mjpegProcess = null;
    });
}

/**
 * Extract JPEG Frames
 * Scans the MJPEG accumulator buffer for complete JPEG images (SOI..EOI) and
 * stores the most recent one as latestFrame, bumping the sequence/ETag and
 * emitting a 'frame' event for long-poll waiters.
 */
function extractJpegFrames() {
    while (true) {
        const soi = mjpegBuffer.indexOf(JPEG_SOI);
        if (soi < 0) {
            // No start marker yet — keep only a tail in case it's split across chunks
            if (mjpegBuffer.length > 2) mjpegBuffer = mjpegBuffer.subarray(mjpegBuffer.length - 1);
            break;
        }
        const eoi = mjpegBuffer.indexOf(JPEG_EOI, soi + 2);
        if (eoi < 0) {
            // Incomplete frame — drop anything before SOI, wait for more data
            if (soi > 0) mjpegBuffer = mjpegBuffer.subarray(soi);
            break;
        }
        latestFrame = mjpegBuffer.subarray(soi, eoi + 2);
        frameSeq++;
        mjpegBuffer = mjpegBuffer.subarray(eoi + 2);
        ev.emit('frame');
    }

    // Safety valve: never let the accumulator grow unbounded
    if (mjpegBuffer.length > 5_000_000) {
        utils.log('⚠️ MJPEG buffer overflow, resetting', 'warn');
        mjpegBuffer = Buffer.alloc(0);
    }
}

/**
 * Get Latest Frame
 * @returns {Buffer|null} Most recent JPEG frame, or null if none yet
 */
function getLatestFrame() {
    return latestFrame;
}

/**
 * Module Exports
 * Exposes transcoding functions, getters, and event emitter
 */
module.exports = {
    // Core functions
    initTranscode,
    startTranscoding,
    stopTranscoding,
    handleVideoData,
    handleAudioData,
    clearMetadata,
    getLatestSnapshot,
    saveSnapshotToDisk,

    // Frame view (Data Saver)
    startFrameMode,
    stopFrameMode,
    getLatestFrame,

    // Event emitter for snapshot + frame notifications
    event: ev,

    // Read-only property getters
    get videoMetadata() { return videoMetadata; },
    get audioMetadata() { return audioMetadata; },
    get getOutputStream() { return outputStream; },
    get getInitSegment() { return initSegment; },
    get videoScale() { return CONFIG.VIDEO_SCALE; },
    get isTranscoding() { return isTranscoding; },
    get hasInitSegment() { return initSegment !== null; },
    get hasKeyframeSegment() { return lastKeyframeSegment !== null; },
    get isFrameMode() { return frameMode; },
    get frameEtag() { return `"f${frameSeq}"`; },

    // Writable property setter
    set currentDevice(name) { currentDevice = name; },
};