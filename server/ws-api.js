/**
 * WebSocket API Server Module
 * 
 * Provides real-time bidirectional communication via WebSocket for:
 * - JSON-based API commands
 * - Event broadcasting to all connected clients
 * - Dynamic message handler registration
 * - Client connection management
 * 
 * WebSocket endpoint: ws://localhost:PORT/api
 */

const utils = require('./utils');

const { WebSocketServer } = require('ws');
const eufyVersion = require('eufy-security-client/package.json').version;
const serverVersion = require('../package.json').version;

let wss = null;                          // WebSocket Server instance
const wsClients = new Set();             // Set of connected WebSocket clients
const messageHandlers = new Map();       // Map of command -> handler function
let binaryHandler = null;               // Handler for binary WebSocket messages

/**
 * Initialize WebSocket Server
 * Sets up WebSocket server for real-time JSON-based API communication
 * @param {http.Server} httpServer - HTTP server instance to attach WebSocket server to
 * @param {number} port - Port number for logging purposes
 */
function initWebSocketServer(httpServer, port) {
    wss = new WebSocketServer({
        noServer: true,        // Manual upgrade handling for path filtering
        path: '/api'           // WebSocket endpoint path
    });

    // Handle WebSocket upgrade requests
    httpServer.on('upgrade', (request, socket, head) => {
        const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

        // Only upgrade connections to /api endpoint
        if (pathname === '/api') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else {
            // Reject connections to other paths
            socket.destroy();
        }
    });

    /**
     * Handle new WebSocket client connections
     */
    wss.on('connection', (ws, request) => {
        const clientIp = request.socket.remoteAddress;
        utils.log(`🔌 WebSocket API client connected from ${clientIp}`, 'info');

        // Register new client
        wsClients.add(ws);

        // Keepalive pings — Tailscale Serve drops idle WebSocket connections
        const pingInterval = setInterval(() => {
            if (ws.readyState === ws.OPEN) {
                ws.ping();
            } else {
                clearInterval(pingInterval);
            }
        }, 15000);
        ws.on('close', () => clearInterval(pingInterval));

        // Ensure handlers are registered before accepting connections
        if (messageHandlers.size === 0) {
            utils.log('⚠️ No WebSocket message handlers registered! Closing connection.', 'warn');
            ws.close();
            return;
        }

        // Send version information as welcome message
        wsSendToClient(ws, {
            type: 'version',
            serverVersion: serverVersion,
            clientVersion: eufyVersion,
        });

        /**
         * Handle incoming messages from client
         * Parses JSON and dispatches to registered handlers
         */
        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                // Route binary data to registered binary handler (e.g., talkback audio)
                if (binaryHandler) {
                    binaryHandler(data, ws);
                }
                return;
            }
            try {
                const message = JSON.parse(data.toString());
                handleWebSocketMessage(ws, message);
            } catch (error) {
                utils.log(`❌ WebSocket API parsing error: ${error.message}`, 'error');
                wsSendToClient(ws, {
                    type: 'error',
                    error: 'Invalid JSON format',
                    message: error.message
                });
            }
        });

        /**
         * Handle client disconnection
         * Cleanup and remove from active clients
         */
        ws.on('close', () => {
            wsClients.delete(ws);
            utils.log(`🔌 WebSocket API client disconnected (${wsClients.size} remaining)`, 'info');
        });

        /**
         * Handle WebSocket errors
         * Log and cleanup connection
         */
        ws.on('error', (error) => {
            utils.log(`❌ WebSocket API error: ${error.message}`, 'error');
            wsClients.delete(ws);
        });
    });

    utils.log(`🔌 WebSocket API server initialized at ws://localhost:${port}/api`, 'info');
}

/**
 * Handle WebSocket Message
 * Processes incoming messages and dispatches to appropriate handlers
 * Supports both synchronous and asynchronous (Promise-based) handlers
 * @param {WebSocket} ws - Client WebSocket connection
 * @param {Object} message - Parsed JSON message object
 */
function handleWebSocketMessage(ws, message) {
    utils.log(`📨 WebSocket API message: ${JSON.stringify(message)}`, 'debug');

    // Validate message has required command field
    if (!message.command) {
        wsSendToClient(ws, {
            type: 'error',
            error: 'Missing message type',
            message: 'Message must have a "type" field'
        });
        return;
    }

    // Dispatch to registered handler if available
    if (messageHandlers.has(message.command)) {
        const handler = messageHandlers.get(message.command);
        try {
            const result = handler(message, ws);
            // Handle async handlers (Promise-based)
            if (result && typeof result.then === 'function') {
                result
                    .then((response) => {
                        // Send response if handler returns data
                        if (response) {
                            wsSendToClient(ws, response);
                        }
                    })
                    .catch((error) => {
                        wsSendToClient(ws, {
                            type: 'error',
                            error: 'Handler error',
                            message: error.message,
                            originalType: message.command
                        });
                    });
            } else if (result) {
                // Handle synchronous result from handler
                wsSendToClient(ws, result);
            }
        } catch (error) {
            utils.log(`❌ Error in message handler for ${message.command}: ${error.message}`, 'error');
            wsSendToClient(ws, {
                type: 'result',
                error: 'Handler error',
                message: error.message,
                messageId: message.command
            });
        }
    } else {
        // Command not registered - notify client
        wsSendToClient(ws, {
            type: 'result',
            error: 'Unknown command',
            messageId: message.command,
            timestamp: new Date().toISOString()
        });
    }
}

/**
 * Send Message to Client
 * Sends JSON message to a specific WebSocket client
 * Only sends if connection is open
 * @param {WebSocket} ws - Client WebSocket connection
 * @param {Object} message - Message object to serialize and send
 */
function wsSendToClient(ws, message) {
    if (ws.readyState === ws.OPEN) {
        try {
            ws.send(JSON.stringify(message));
        } catch (error) {
            utils.log(`❌ Error sending to WebSocket client: ${error.message}`, 'error');
        }
    }
}

/**
 * Broadcast Message
 * Sends JSON message to all connected WebSocket clients
 * Useful for event notifications that all clients should receive
 * @param {Object} message - Message object to broadcast
 */
function wsBroadcast(message) {
    const messageStr = JSON.stringify(message);
    wsClients.forEach(client => {
        if (client.readyState === client.OPEN) {
            try {
                client.send(messageStr);
            } catch (error) {
                utils.log(`❌ Error broadcasting to client: ${error.message}`, 'error');
            }
        }
    });
}

/**
 * Register Message Handler
 * Registers a handler function for a specific command type
 * Handlers can be synchronous or return Promises for async operations
 * @param {string} messageType - Command type to handle (e.g., 'start_stream')
 * @param {Function} handler - Handler function (message, ws) => response|Promise<response>
 * @throws {Error} If handler is not a function
 */
function registerMessageHandler(messageType, handler) {
    if (typeof handler !== 'function') {
        throw new Error('Handler must be a function');
    }
    messageHandlers.set(messageType, handler);
    utils.log(`📝 Registered message handler for: ${messageType}`, 'debug');
}

/**
 * Register Binary Handler
 * Registers a handler for binary WebSocket messages (e.g., talkback audio)
 * @param {Function} handler - Handler function (data, ws) => void
 */
function registerBinaryHandler(handler) {
    if (typeof handler !== 'function') {
        throw new Error('Binary handler must be a function');
    }
    binaryHandler = handler;
    utils.log('📝 Registered binary message handler', 'debug');
}

function unregisterMessageHandler(messageType) {
    const removed = messageHandlers.delete(messageType);
    if (removed) {
        utils.log(`🗑️ Unregistered message handler for: ${messageType}`, 'debug');
    }
    return removed;
}

/**
 * Get Registered Message Types
 * Returns list of all currently registered command types
 * Useful for debugging and capability discovery
 * @returns {Array<string>} Array of registered command types
 */
function getRegisteredMessageTypes() {
    return Array.from(messageHandlers.keys());
}

/**
 * Module Exports
 * Exposes WebSocket server management and communication functions
 */
module.exports = {
    initWebSocketServer,
    wsBroadcast,
    registerMessageHandler,
    registerBinaryHandler,
    unregisterMessageHandler,
    getRegisteredMessageTypes
};
