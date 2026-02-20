const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const osc = require('osc');
const { z } = require('zod');

const DEFAULTS = {
  bridgeHost: '0.0.0.0',
  bridgePort: 8787,
  allowedOrigin: '*',
  oscTargetHost: '127.0.0.1',
  oscTargetPort: 16447,
  telemetryListenHost: '0.0.0.0',
  telemetryListenPort: 16448,
  telemetryScanAddress: '/ec2/telemetry/scan',
  oscChannelPrefix: '/pose/out',
  channelCount: 16,
  maxMessagesPerSecond: 60,
  oscActivityLogIntervalMs: 1000,
};

function parseNumber(rawValue, fallback) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePrefix(prefix) {
  return (prefix || DEFAULTS.oscChannelPrefix).replace(/\/+$/, '') || DEFAULTS.oscChannelPrefix;
}

const config = {
  bridgeHost: process.env.BRIDGE_HOST || DEFAULTS.bridgeHost,
  bridgePort: parseNumber(process.env.BRIDGE_PORT, DEFAULTS.bridgePort),
  allowedOrigin: process.env.ALLOWED_ORIGIN || DEFAULTS.allowedOrigin,
  oscTargetHost: process.env.OSC_TARGET_HOST || DEFAULTS.oscTargetHost,
  oscTargetPort: parseNumber(process.env.OSC_TARGET_PORT, DEFAULTS.oscTargetPort),
  telemetryListenHost: process.env.TELEMETRY_LISTEN_HOST || DEFAULTS.telemetryListenHost,
  telemetryListenPort: parseNumber(
    process.env.TELEMETRY_LISTEN_PORT,
    DEFAULTS.telemetryListenPort,
  ),
  telemetryScanAddress:
    process.env.TELEMETRY_SCAN_ADDRESS || DEFAULTS.telemetryScanAddress,
  oscChannelPrefix: normalizePrefix(process.env.OSC_CHANNEL_PREFIX),
  channelCount: parseNumber(process.env.CHANNEL_COUNT, DEFAULTS.channelCount),
  maxMessagesPerSecond: parseNumber(
    process.env.MAX_MESSAGES_PER_SECOND,
    DEFAULTS.maxMessagesPerSecond,
  ),
  oscActivityLogIntervalMs: Math.max(
    0,
    parseNumber(
      process.env.OSC_ACTIVITY_LOG_INTERVAL_MS,
      DEFAULTS.oscActivityLogIntervalMs,
    ),
  ),
};

const channelMessageSchema = z.object({
  channel: z.number().int().min(1).max(64),
  value: z.number().min(0).max(1),
});

const channelBatchSchema = z.object({
  channels: z.array(channelMessageSchema).min(1).max(64),
});

const oscArgSchema = z.object({
  type: z.enum(['f', 'i', 'd', 's']),
  value: z.union([z.number(), z.string()]),
});

const oscMessageSchema = z.object({
  address: z.string().min(1).regex(/^\//, 'OSC addresses must start with /'),
  args: z.array(oscArgSchema).default([]),
  rateLimitKey: z.string().optional(),
});

const oscBatchSchema = z.object({
  messages: z.array(oscMessageSchema).min(1).max(64),
});

const wsMessageSchema = z.union([
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('channel:set'),
    payload: channelMessageSchema,
  }),
  z.object({
    type: z.literal('channels:set'),
    payload: channelBatchSchema,
  }),
  z.object({
    type: z.literal('osc:send'),
    payload: oscMessageSchema,
  }),
  z.object({
    type: z.literal('osc:batch'),
    payload: oscBatchSchema,
  }),
]);

const stats = {
  startedAtMs: Date.now(),
  activeWsClients: 0,
  oscSentCount: 0,
  telemetryReceivedCount: 0,
  telemetryBroadcastCount: 0,
  droppedRateLimitedCount: 0,
  rejectedValidationCount: 0,
  oscErrorCount: 0,
};

const minIntervalMs =
  config.maxMessagesPerSecond > 0 ? Math.floor(1000 / config.maxMessagesPerSecond) : 0;
const lastSentByKey = new Map();
let oscReady = false;
let telemetryReady = false;
let activityLogInterval = null;

function createHealthPayload() {
  return {
    status: 'ok',
    bridgeReady: true,
    oscReady,
    telemetryReady,
    activeWsClients: stats.activeWsClients,
    uptimeSeconds: Math.floor((Date.now() - stats.startedAtMs) / 1000),
    counters: {
      oscSentCount: stats.oscSentCount,
      telemetryReceivedCount: stats.telemetryReceivedCount,
      telemetryBroadcastCount: stats.telemetryBroadcastCount,
      droppedRateLimitedCount: stats.droppedRateLimitedCount,
      rejectedValidationCount: stats.rejectedValidationCount,
      oscErrorCount: stats.oscErrorCount,
    },
    config: {
      bridgeHost: config.bridgeHost,
      bridgePort: config.bridgePort,
      oscTargetHost: config.oscTargetHost,
      oscTargetPort: config.oscTargetPort,
      telemetryListenHost: config.telemetryListenHost,
      telemetryListenPort: config.telemetryListenPort,
      telemetryScanAddress: config.telemetryScanAddress,
      channelCount: config.channelCount,
      oscChannelPrefix: config.oscChannelPrefix,
      maxMessagesPerSecond: config.maxMessagesPerSecond,
      oscActivityLogIntervalMs: config.oscActivityLogIntervalMs,
      allowedOrigin: config.allowedOrigin,
    },
  };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function parseFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOscNumericArg(rawArg) {
  if (
    rawArg &&
    typeof rawArg === 'object' &&
    Object.prototype.hasOwnProperty.call(rawArg, 'value')
  ) {
    return parseFiniteNumber(rawArg.value);
  }
  return parseFiniteNumber(rawArg);
}

function parseScanTelemetryMessage(message) {
  if (!message || typeof message.address !== 'string') {
    return null;
  }

  if (message.address !== config.telemetryScanAddress) {
    return null;
  }

  const args = Array.isArray(message.args) ? message.args : [];
  if (args.length < 3) {
    return null;
  }

  const playheadNorm = parseOscNumericArg(args[0]);
  const scanHeadNorm = parseOscNumericArg(args[1]);
  const scanRangeNorm = parseOscNumericArg(args[2]);
  if (playheadNorm == null || scanHeadNorm == null || scanRangeNorm == null) {
    return null;
  }

  const soundFileFramesRaw = args.length >= 4 ? parseOscNumericArg(args[3]) : null;
  const soundFileFrames =
    soundFileFramesRaw != null && soundFileFramesRaw > 1
      ? Math.trunc(soundFileFramesRaw)
      : null;
  const activeGrainIndices = [];
  for (let index = 4; index < args.length && activeGrainIndices.length < 2048; index += 1) {
    const value = parseOscNumericArg(args[index]);
    if (value == null) {
      continue;
    }
    activeGrainIndices.push(Math.max(0, Math.trunc(value)));
  }

  const activeGrainNormPositions = activeGrainIndices.map((grainIndex) =>
    soundFileFrames && soundFileFrames > 1
      ? clamp01(grainIndex / soundFileFrames)
      : clamp01(grainIndex),
  );

  return {
    source: 'bridge',
    timestampMs: Date.now(),
    playheadNorm: clamp01(playheadNorm),
    scanHeadNorm: clamp01(scanHeadNorm),
    scanRangeNorm: clamp01(scanRangeNorm),
    soundFileFrames,
    activeGrainCount: activeGrainIndices.length,
    activeGrainIndices,
    activeGrainNormPositions,
  };
}

function shouldRateLimit(key) {
  if (!key || minIntervalMs <= 0) {
    return false;
  }

  const nowMs = Date.now();
  const lastMs = lastSentByKey.get(key);
  if (typeof lastMs === 'number' && nowMs - lastMs < minIntervalMs) {
    return true;
  }

  lastSentByKey.set(key, nowMs);
  return false;
}

function normalizeOscArg(arg) {
  if (arg.type === 's') {
    return {
      type: 's',
      value: String(arg.value),
    };
  }

  if (arg.type === 'i') {
    return {
      type: 'i',
      value: Math.trunc(Number(arg.value)),
    };
  }

  return {
    type: arg.type,
    value: Number(arg.value),
  };
}

function sendOscMessage(message, rateLimitKey) {
  if (!oscReady) {
    return {
      sent: false,
      error: 'osc_not_ready',
    };
  }

  if (shouldRateLimit(rateLimitKey)) {
    stats.droppedRateLimitedCount += 1;
    return {
      sent: false,
      rateLimited: true,
    };
  }

  try {
    udpPort.send({
      address: message.address,
      args: message.args.map((arg) => normalizeOscArg(arg)),
    });
    stats.oscSentCount += 1;
    return { sent: true };
  } catch (error) {
    stats.oscErrorCount += 1;
    return {
      sent: false,
      error: error instanceof Error ? error.message : 'unknown_osc_error',
    };
  }
}

function channelToAddress(channel) {
  const safeChannel = Math.max(1, Math.min(config.channelCount, channel));
  return `${config.oscChannelPrefix}/${String(safeChannel).padStart(2, '0')}`;
}

function sendChannel(channel, value) {
  const address = channelToAddress(channel);
  const result = sendOscMessage(
    {
      address,
      args: [{ type: 'f', value }],
    },
    `channel:${channel}`,
  );

  return {
    ...result,
    address,
    channel,
    value,
  };
}

function startActivityLogLoop() {
  if (config.oscActivityLogIntervalMs <= 0) {
    return;
  }

  const intervalLabel =
    config.oscActivityLogIntervalMs % 1000 === 0
      ? `${config.oscActivityLogIntervalMs / 1000}s`
      : `${config.oscActivityLogIntervalMs}ms`;

  let lastOscSentCount = stats.oscSentCount;
  let lastTelemetryReceivedCount = stats.telemetryReceivedCount;
  let lastRateLimitedCount = stats.droppedRateLimitedCount;
  let lastOscErrorCount = stats.oscErrorCount;

  activityLogInterval = setInterval(() => {
    const oscSentDelta = stats.oscSentCount - lastOscSentCount;
    const telemetryReceivedDelta = stats.telemetryReceivedCount - lastTelemetryReceivedCount;
    const rateLimitedDelta = stats.droppedRateLimitedCount - lastRateLimitedCount;
    const oscErrorDelta = stats.oscErrorCount - lastOscErrorCount;

    lastOscSentCount = stats.oscSentCount;
    lastTelemetryReceivedCount = stats.telemetryReceivedCount;
    lastRateLimitedCount = stats.droppedRateLimitedCount;
    lastOscErrorCount = stats.oscErrorCount;

    if (
      oscSentDelta <= 0 &&
      telemetryReceivedDelta <= 0 &&
      rateLimitedDelta <= 0 &&
      oscErrorDelta <= 0
    ) {
      return;
    }

    console.log(
      `[bridge] Activity ${intervalLabel}: oscSent=${oscSentDelta} telemetryRx=${telemetryReceivedDelta} rateLimited=${rateLimitedDelta} errors=${oscErrorDelta} target=${config.oscTargetHost}:${config.oscTargetPort} telemetry=${config.telemetryListenHost}:${config.telemetryListenPort}`,
    );
  }, config.oscActivityLogIntervalMs);

  if (typeof activityLogInterval.unref === 'function') {
    activityLogInterval.unref();
  }
}

function createValidationErrorResponse(validationError) {
  stats.rejectedValidationCount += 1;
  return {
    error: 'validation_failed',
    issues: validationError.issues,
  };
}

const udpPort = new osc.UDPPort({
  localAddress: '0.0.0.0',
  localPort: 0,
  remoteAddress: config.oscTargetHost,
  remotePort: config.oscTargetPort,
  metadata: true,
});

udpPort.on('ready', () => {
  oscReady = true;
  console.log(
    `[bridge] OSC ready: forwarding to ${config.oscTargetHost}:${config.oscTargetPort}`,
  );
});

udpPort.on('error', (error) => {
  stats.oscErrorCount += 1;
  console.error('[bridge] OSC error:', error);
});

udpPort.open();

const app = express();
const corsOptions = config.allowedOrigin === '*' ? undefined : { origin: config.allowedOrigin };
app.use(cors(corsOptions));
app.use(express.json({ limit: '512kb' }));

app.get('/health', (_request, response) => {
  response.status(200).json(createHealthPayload());
});

app.get('/config', (_request, response) => {
  response.status(200).json({
    bridgeHost: config.bridgeHost,
    bridgePort: config.bridgePort,
    oscTargetHost: config.oscTargetHost,
    oscTargetPort: config.oscTargetPort,
    telemetryListenHost: config.telemetryListenHost,
    telemetryListenPort: config.telemetryListenPort,
    telemetryScanAddress: config.telemetryScanAddress,
    oscChannelPrefix: config.oscChannelPrefix,
    channelCount: config.channelCount,
    maxMessagesPerSecond: config.maxMessagesPerSecond,
    oscActivityLogIntervalMs: config.oscActivityLogIntervalMs,
    allowedOrigin: config.allowedOrigin,
  });
});

app.post('/api/channels', (request, response) => {
  const parsed = channelMessageSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json(createValidationErrorResponse(parsed.error));
    return;
  }

  const result = sendChannel(parsed.data.channel, parsed.data.value);
  if (result.error === 'osc_not_ready') {
    response.status(503).json({ error: result.error });
    return;
  }

  response.status(200).json(result);
});

app.post('/api/channels/batch', (request, response) => {
  const parsed = channelBatchSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json(createValidationErrorResponse(parsed.error));
    return;
  }

  let sentCount = 0;
  let droppedCount = 0;

  for (const channelMessage of parsed.data.channels) {
    const result = sendChannel(channelMessage.channel, channelMessage.value);
    if (result.sent) {
      sentCount += 1;
    } else if (result.rateLimited) {
      droppedCount += 1;
    }
  }

  response.status(200).json({
    total: parsed.data.channels.length,
    sentCount,
    droppedCount,
  });
});

app.post('/api/osc', (request, response) => {
  const parsed = oscMessageSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json(createValidationErrorResponse(parsed.error));
    return;
  }

  const result = sendOscMessage(parsed.data, parsed.data.rateLimitKey || parsed.data.address);
  if (result.error === 'osc_not_ready') {
    response.status(503).json({ error: result.error });
    return;
  }

  response.status(200).json(result);
});

app.post('/api/osc/batch', (request, response) => {
  const parsed = oscBatchSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json(createValidationErrorResponse(parsed.error));
    return;
  }

  let sentCount = 0;
  let droppedCount = 0;

  for (const message of parsed.data.messages) {
    const result = sendOscMessage(message, message.rateLimitKey || message.address);
    if (result.sent) {
      sentCount += 1;
    } else if (result.rateLimited) {
      droppedCount += 1;
    }
  }

  response.status(200).json({
    total: parsed.data.messages.length,
    sentCount,
    droppedCount,
  });
});

const server = app.listen(config.bridgePort, config.bridgeHost, () => {
  console.log(`[bridge] Listening on http://${config.bridgeHost}:${config.bridgePort}`);
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
});

function broadcastTelemetryScan(payload) {
  const envelope = {
    type: 'telemetry:scan',
    payload,
  };

  wss.clients.forEach((client) => {
    sendWsJson(client, envelope);
    stats.telemetryBroadcastCount += 1;
  });
}

function sendWsJson(socket, payload) {
  if (socket.readyState !== socket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

wss.on('connection', (socket) => {
  stats.activeWsClients += 1;

  sendWsJson(socket, {
    type: 'bridge:hello',
    payload: {
      oscReady,
      telemetryReady,
      bridgePort: config.bridgePort,
      oscTargetHost: config.oscTargetHost,
      oscTargetPort: config.oscTargetPort,
      telemetryListenPort: config.telemetryListenPort,
      channelCount: config.channelCount,
    },
  });

  socket.on('message', (rawMessage) => {
    let parsedJson;
    try {
      parsedJson = JSON.parse(rawMessage.toString());
    } catch {
      sendWsJson(socket, {
        type: 'bridge:error',
        payload: { error: 'invalid_json' },
      });
      return;
    }

    const parsedMessage = wsMessageSchema.safeParse(parsedJson);
    if (!parsedMessage.success) {
      stats.rejectedValidationCount += 1;
      sendWsJson(socket, {
        type: 'bridge:error',
        payload: {
          error: 'validation_failed',
          issues: parsedMessage.error.issues,
        },
      });
      return;
    }

    if (parsedMessage.data.type === 'ping') {
      sendWsJson(socket, { type: 'pong', payload: { nowMs: Date.now() } });
      return;
    }

    if (parsedMessage.data.type === 'channel:set') {
      const result = sendChannel(
        parsedMessage.data.payload.channel,
        parsedMessage.data.payload.value,
      );
      sendWsJson(socket, {
        type: 'bridge:ack',
        payload: result,
      });
      return;
    }

    if (parsedMessage.data.type === 'channels:set') {
      let sentCount = 0;
      let droppedCount = 0;

      for (const channelMessage of parsedMessage.data.payload.channels) {
        const result = sendChannel(channelMessage.channel, channelMessage.value);
        if (result.sent) {
          sentCount += 1;
        } else if (result.rateLimited) {
          droppedCount += 1;
        }
      }

      sendWsJson(socket, {
        type: 'bridge:ack',
        payload: {
          total: parsedMessage.data.payload.channels.length,
          sentCount,
          droppedCount,
        },
      });
      return;
    }

    if (parsedMessage.data.type === 'osc:send') {
      const result = sendOscMessage(
        parsedMessage.data.payload,
        parsedMessage.data.payload.rateLimitKey || parsedMessage.data.payload.address,
      );
      sendWsJson(socket, {
        type: 'bridge:ack',
        payload: result,
      });
      return;
    }

    if (parsedMessage.data.type === 'osc:batch') {
      let sentCount = 0;
      let droppedCount = 0;

      for (const message of parsedMessage.data.payload.messages) {
        const result = sendOscMessage(message, message.rateLimitKey || message.address);
        if (result.sent) {
          sentCount += 1;
        } else if (result.rateLimited) {
          droppedCount += 1;
        }
      }

      sendWsJson(socket, {
        type: 'bridge:ack',
        payload: {
          total: parsedMessage.data.payload.messages.length,
          sentCount,
          droppedCount,
        },
      });
    }
  });

  socket.on('close', () => {
    stats.activeWsClients = Math.max(0, stats.activeWsClients - 1);
  });
});

const telemetryUdpPort = new osc.UDPPort({
  localAddress: config.telemetryListenHost,
  localPort: config.telemetryListenPort,
  metadata: true,
});

telemetryUdpPort.on('ready', () => {
  telemetryReady = true;
  console.log(
    `[bridge] Telemetry OSC ready: listening on ${config.telemetryListenHost}:${config.telemetryListenPort}`,
  );
});

telemetryUdpPort.on('message', (message) => {
  const payload = parseScanTelemetryMessage(message);
  if (!payload) {
    return;
  }

  stats.telemetryReceivedCount += 1;
  broadcastTelemetryScan(payload);
});

telemetryUdpPort.on('error', (error) => {
  telemetryReady = false;
  stats.oscErrorCount += 1;
  console.error('[bridge] Telemetry OSC error:', error);
});

telemetryUdpPort.open();
startActivityLogLoop();

function shutdown(signal) {
  console.log(`[bridge] Received ${signal}, shutting down...`);

  if (activityLogInterval) {
    clearInterval(activityLogInterval);
    activityLogInterval = null;
  }

  wss.close(() => {
    server.close(() => {
      try {
        udpPort.close();
      } catch {
        // ignore close errors
      }
      try {
        telemetryUdpPort.close();
      } catch {
        // ignore close errors
      }
      process.exit(0);
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
