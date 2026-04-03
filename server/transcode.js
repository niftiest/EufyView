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
let segmentSizes = [];                 // Track segment sizes for adaptive threshold
let largestSegmentSize = 0;            // Largest segment size seen

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
         * Adaptive Keyframe Detection
         * Keyframes contain I-frames and are significantly larger than P/B-frames
         * Initial phase: Use fixed 300KB threshold
         * After calibration: Use 70% of largest segment as threshold
         */
        let isLikelyKeyframe = false;
        if (segmentSizes.length < 5) {
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

    // Ensure snapshots directory exists
    if (!fs.existsSync(utils.snapshotDir)) {
        fs.mkdirSync(utils.snapshotDir, { recursive: true });
    }

    try {
        // Store device SN for async callback
        const deviceSN = currentDevice;

        /**
         * FFmpeg Snapshot Extraction
         * Decodes fMP4 buffer and extracts first frame as high-quality JPEG
         */
        const ffmpeg = spawn(FFMPEG_PATH, [
            '-y',                           // Overwrite output file
            '-f', 'mp4',                    // Input format
            '-i', 'pipe:0',                 // Read from stdin
            '-vframes', '1',                // Extract only first frame
            '-pix_fmt', 'yuvj420p',         // Full-range YUV for JPEG
            '-q:v', '2',                    // High quality JPEG (2-5 is best)
            snapshotPath
        ]);

        // Write fMP4 buffer to FFmpeg stdin
        ffmpeg.stdin.write(lastSnapshotBuffer, (err) => {
            if (err) {
                utils.log(`⚠️ Error writing to FFmpeg stdin: ${err}`, 'warn');
            }
            ffmpeg.stdin.end();
        });

        // Log FFmpeg output for debugging
        ffmpeg.stderr.on('data', (data) => {
            utils.log(`FFmpeg snapshot: ${data.toString().trim()}`, 'debug');
        });

        // Handle successful snapshot extraction
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                utils.log(`✅ Snapshot saved to disk: ${snapshotPath}`, 'debug');
                // Update snapshot timestamp and emit event
                utils.saveSnapshotDatetime(deviceSN);
                ev.emit('snapshotSaved', deviceSN);
            } else {
                utils.log(`❌ Snapshot save failed with code ${code}`, 'error');
            }
        });

        // Handle FFmpeg errors
        ffmpeg.on('error', (err) => {
            utils.log(`❌ Snapshot save error: ${err}`, 'error');
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

    // Event emitter for snapshot notifications
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

    // Writable property setter
    set currentDevice(name) { currentDevice = name; },
};