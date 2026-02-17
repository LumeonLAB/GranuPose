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
  oscChannelPrefix: '/pose/out',
  channelCount: 16,
  maxMessagesPerSecond: 60,
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
  oscChannelPrefix: normalizePrefix(process.env.OSC_CHANNEL_PREFIX),
  channelCount: parseNumber(process.env.CHANNEL_COUNT, DEFAULTS.channelCount),
  maxMessagesPerSecond: parseNumber(
    process.env.MAX_MESSAGES_PER_SECOND,
    DEFAULTS.maxMessagesPerSecond,
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
  droppedRateLimitedCount: 0,
  rejectedValidationCount: 0,
  oscErrorCount: 0,
};

const minIntervalMs =
  config.maxMessagesPerSecond > 0 ? Math.floor(1000 / config.maxMessagesPerSecond) : 0;
const lastSentByKey = new Map();
let oscReady = false;

function createHealthPayload() {
  return {
    status: 'ok',
    bridgeReady: true,
    oscReady,
    activeWsClients: stats.activeWsClients,
    uptimeSeconds: Math.floor((Date.now() - stats.startedAtMs) / 1000),
    counters: {
      oscSentCount: stats.oscSentCount,
      droppedRateLimitedCount: stats.droppedRateLimitedCount,
      rejectedValidationCount: stats.rejectedValidationCount,
      oscErrorCount: stats.oscErrorCount,
    },
    config: {
      bridgeHost: config.bridgeHost,
      bridgePort: config.bridgePort,
      oscTargetHost: config.oscTargetHost,
      oscTargetPort: config.oscTargetPort,
      channelCount: config.channelCount,
      oscChannelPrefix: config.oscChannelPrefix,
      maxMessagesPerSecond: config.maxMessagesPerSecond,
      allowedOrigin: config.allowedOrigin,
    },
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
    oscChannelPrefix: config.oscChannelPrefix,
    channelCount: config.channelCount,
    maxMessagesPerSecond: config.maxMessagesPerSecond,
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
      bridgePort: config.bridgePort,
      oscTargetHost: config.oscTargetHost,
      oscTargetPort: config.oscTargetPort,
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

function shutdown(signal) {
  console.log(`[bridge] Received ${signal}, shutting down...`);

  wss.close(() => {
    server.close(() => {
      try {
        udpPort.close();
      } catch {
        // ignore close errors
      }
      process.exit(0);
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
