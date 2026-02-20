#!/usr/bin/env node

const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const osc = require('osc');

const DEFAULTS = {
  oscHost: process.env.HEADLESS_SMOKE_OSC_HOST || '127.0.0.1',
  oscPort: parseBoundedInt(process.env.HEADLESS_SMOKE_OSC_PORT, 17447, 1, 65535),
  telemetryHost: process.env.HEADLESS_SMOKE_TELEMETRY_HOST || '127.0.0.1',
  telemetryPort: parseBoundedInt(process.env.HEADLESS_SMOKE_TELEMETRY_PORT, 17448, 1, 65535),
  timeoutMs: parseBoundedInt(process.env.HEADLESS_SMOKE_TIMEOUT_MS, 15000, 2000, 120000),
  noAudio: parseBooleanEnv(process.env.HEADLESS_SMOKE_NO_AUDIO, true),
  autostartAudio: parseBooleanEnv(process.env.HEADLESS_SMOKE_AUTOSTART_AUDIO, false),
  outputPath: resolvePathFromEnv(
    process.env.HEADLESS_SMOKE_OUTPUT || 'docs/headless-smoke-latest.json',
    path.resolve(__dirname, '..'),
  ),
  keepTemp: parseBooleanEnv(process.env.HEADLESS_SMOKE_KEEP_TEMP, false),
};

function parseBoundedInt(rawValue, fallback, min, max) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.trunc(parsed);
  return Math.max(min, Math.min(max, rounded));
}

function parseBooleanEnv(rawValue, fallback) {
  if (typeof rawValue !== 'string') {
    return fallback;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function resolvePathFromEnv(rawPath, basePath = process.cwd()) {
  if (typeof rawPath !== 'string') {
    return '';
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return '';
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(basePath, trimmed);
}

function dedupe(values) {
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(trimmed);
  }
  return unique;
}

function getPlatformDirectory() {
  if (process.platform === 'win32') {
    return 'win32';
  }
  if (process.platform === 'darwin') {
    return 'darwin';
  }
  return 'linux';
}

function getEngineBinaryName() {
  return process.platform === 'win32' ? 'ec2_headless.exe' : 'ec2_headless';
}

async function resolveFirstExistingPath(candidates) {
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  return '';
}

function appendEnvPathValue(existingValue, prependPath) {
  if (!prependPath) {
    return existingValue || '';
  }
  if (!existingValue) {
    return prependPath;
  }
  return `${prependPath}${path.delimiter}${existingValue}`;
}

function parseOscNumericArg(rawArg) {
  if (
    rawArg &&
    typeof rawArg === 'object' &&
    Object.prototype.hasOwnProperty.call(rawArg, 'value')
  ) {
    const parsed = Number(rawArg.value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(rawArg);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTelemetryArg(rawArg) {
  const value =
    rawArg && typeof rawArg === 'object' && Object.prototype.hasOwnProperty.call(rawArg, 'value')
      ? rawArg.value
      : rawArg;
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (value == null) {
    return '';
  }
  return String(value);
}

function parseHelloArgsMap(args) {
  const map = {};
  for (const arg of args) {
    if (typeof arg !== 'string') {
      continue;
    }
    const trimmed = arg.trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }
    map[key] = value;
  }
  return map;
}

function computeScanStats(scans) {
  const safeScans = Array.isArray(scans) ? scans : [];
  if (safeScans.length === 0) {
    return {
      count: 0,
      elapsedMs: 0,
      cadenceHz: 0,
      playheadSpan: 0,
      scanHeadSpan: 0,
      scanRangeSpan: 0,
    };
  }

  let minPlayhead = Infinity;
  let maxPlayhead = -Infinity;
  let minScanHead = Infinity;
  let maxScanHead = -Infinity;
  let minScanRange = Infinity;
  let maxScanRange = -Infinity;

  for (const scan of safeScans) {
    const playheadNorm = Number(scan?.playheadNorm);
    const scanHeadNorm = Number(scan?.scanHeadNorm);
    const scanRangeNorm = Number(scan?.scanRangeNorm);
    if (Number.isFinite(playheadNorm)) {
      minPlayhead = Math.min(minPlayhead, playheadNorm);
      maxPlayhead = Math.max(maxPlayhead, playheadNorm);
    }
    if (Number.isFinite(scanHeadNorm)) {
      minScanHead = Math.min(minScanHead, scanHeadNorm);
      maxScanHead = Math.max(maxScanHead, scanHeadNorm);
    }
    if (Number.isFinite(scanRangeNorm)) {
      minScanRange = Math.min(minScanRange, scanRangeNorm);
      maxScanRange = Math.max(maxScanRange, scanRangeNorm);
    }
  }

  const firstTimestamp = Number(safeScans[0]?.timestampMs) || Date.now();
  const lastTimestamp = Number(safeScans[safeScans.length - 1]?.timestampMs) || firstTimestamp;
  const elapsedMs = Math.max(0, lastTimestamp - firstTimestamp);
  const elapsedSeconds = elapsedMs / 1000;
  const cadenceHz = elapsedSeconds > 0 ? safeScans.length / elapsedSeconds : 0;

  return {
    count: safeScans.length,
    elapsedMs,
    cadenceHz,
    playheadSpan:
      Number.isFinite(minPlayhead) && Number.isFinite(maxPlayhead)
        ? Math.max(0, maxPlayhead - minPlayhead)
        : 0,
    scanHeadSpan:
      Number.isFinite(minScanHead) && Number.isFinite(maxScanHead)
        ? Math.max(0, maxScanHead - minScanHead)
        : 0,
    scanRangeSpan:
      Number.isFinite(minScanRange) && Number.isFinite(maxScanRange)
        ? Math.max(0, maxScanRange - minScanRange)
        : 0,
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForChildSpawn(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timeoutHandle = null;
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error(`engine_spawn_timeout(${timeoutMs}ms)`));
    }, timeoutMs);
  });
}

function openUdpPort(port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle = null;
    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      port.off('ready', onReady);
      port.off('error', onError);
    };
    const onReady = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    port.on('ready', onReady);
    port.on('error', onError);
    try {
      port.open();
    } catch (error) {
      onError(error);
      return;
    }
    timeoutHandle = setTimeout(() => {
      onError(new Error(`udp_port_open_timeout(${timeoutMs}ms)`));
    }, timeoutMs);
  });
}

function closeUdpPort(port) {
  if (!port) {
    return;
  }
  try {
    port.close();
  } catch {
    // ignore close errors
  }
}

function collectProcessLines(stream, targetLines, channel) {
  if (!stream) {
    return;
  }
  let pending = '';
  stream.on('data', (chunk) => {
    pending += String(chunk);
    const splitLines = pending.split(/\r?\n/);
    pending = splitLines.pop() ?? '';
    for (const line of splitLines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      targetLines.push({
        timestampMs: Date.now(),
        channel,
        line: trimmed,
      });
    }
  });
  stream.on('end', () => {
    const trimmed = pending.trim();
    if (!trimmed) {
      return;
    }
    targetLines.push({
      timestampMs: Date.now(),
      channel,
      line: trimmed,
    });
  });
}

function hasLogLine(logEntries, matcher) {
  return logEntries.some((entry) => matcher(entry.line));
}

async function waitForScanCount(telemetryState, minCount, timeoutMs) {
  const deadlineMs = Date.now() + timeoutMs;
  while (Date.now() < deadlineMs) {
    if (telemetryState.scans.length >= minCount) {
      return true;
    }
    await sleep(50);
  }
  return telemetryState.scans.length >= minCount;
}

async function stopChildProcess(child, timeoutMs = 4000) {
  if (!child) {
    return { exited: true, exitCode: null, signal: null, forced: false };
  }

  if (child.exitCode !== null || child.signalCode) {
    return {
      exited: true,
      exitCode: child.exitCode,
      signal: child.signalCode || null,
      forced: false,
    };
  }

  return new Promise((resolve) => {
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore kill failure
      }
    }, timeoutMs);

    child.once('exit', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exited: true,
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: signal || null,
        forced,
      });
    });

    try {
      child.kill('SIGTERM');
    } catch {
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        resolve({
          exited: false,
          exitCode: child.exitCode,
          signal: child.signalCode || null,
          forced: false,
        });
      }
    }
  });
}

async function resolveRuntimeConfig() {
  const poseControllerRoot = path.resolve(__dirname, '..');
  const workspaceRoot = path.resolve(poseControllerRoot, '..');
  const platformDirectory = getPlatformDirectory();
  const binaryName = getEngineBinaryName();

  const binaryCandidates = dedupe([
    resolvePathFromEnv(process.env.HEADLESS_SMOKE_BINARY_PATH, poseControllerRoot),
    resolvePathFromEnv(process.env.GRANUPOSE_ENGINE_PATH, poseControllerRoot),
    path.resolve(poseControllerRoot, 'engine-bin', platformDirectory, binaryName),
    path.resolve(poseControllerRoot, 'engine-bin', binaryName),
    path.resolve(workspaceRoot, 'EmissionControl2', 'ecSource', 'bin', binaryName),
    path.resolve(process.cwd(), 'engine-bin', platformDirectory, binaryName),
    path.resolve(process.cwd(), 'engine-bin', binaryName),
    path.resolve(process.cwd(), 'EmissionControl2', 'ecSource', 'bin', binaryName),
  ]);

  const binaryPath = await resolveFirstExistingPath(binaryCandidates);
  if (!binaryPath) {
    throw new Error(`ec2_headless binary not found. Checked: ${binaryCandidates.join(' | ')}`);
  }

  const samplesCandidates = dedupe([
    resolvePathFromEnv(process.env.HEADLESS_SMOKE_SAMPLES_DIR, poseControllerRoot),
    resolvePathFromEnv(process.env.GRANUPOSE_ENGINE_SAMPLES_DIR, poseControllerRoot),
    path.resolve(poseControllerRoot, 'engine-resources', 'samples'),
    path.resolve(workspaceRoot, 'EmissionControl2', 'externalResources', 'samples'),
  ]);
  const samplesDir = await resolveFirstExistingPath(samplesCandidates);

  const libsCandidates = dedupe([
    resolvePathFromEnv(process.env.HEADLESS_SMOKE_LIB_DIR, poseControllerRoot),
    resolvePathFromEnv(process.env.GRANUPOSE_ENGINE_LIB_DIR, poseControllerRoot),
    path.resolve(poseControllerRoot, 'engine-resources', 'libs'),
    path.resolve(workspaceRoot, 'EmissionControl2', 'externalResources', 'libsndfile'),
  ]);
  const libsDir = await resolveFirstExistingPath(libsCandidates);

  const dataDirOverride =
    resolvePathFromEnv(process.env.HEADLESS_SMOKE_DATA_DIR, poseControllerRoot) ||
    resolvePathFromEnv(process.env.GRANUPOSE_ENGINE_DATA_DIR, poseControllerRoot);
  const dataDir =
    dataDirOverride ||
    path.resolve(os.tmpdir(), `granuPose-headless-smoke-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
  await fsp.mkdir(dataDir, { recursive: true });

  const spawnEnv = { ...process.env };
  if (libsDir) {
    if (process.platform === 'win32') {
      spawnEnv.PATH = appendEnvPathValue(spawnEnv.PATH, libsDir);
    } else if (process.platform === 'darwin') {
      spawnEnv.DYLD_LIBRARY_PATH = appendEnvPathValue(spawnEnv.DYLD_LIBRARY_PATH, libsDir);
    } else {
      spawnEnv.LD_LIBRARY_PATH = appendEnvPathValue(spawnEnv.LD_LIBRARY_PATH, libsDir);
    }
  }

  const args = [
    '--osc-host',
    DEFAULTS.oscHost,
    '--osc-port',
    String(DEFAULTS.oscPort),
    '--telemetry-host',
    DEFAULTS.telemetryHost,
    '--telemetry-port',
    String(DEFAULTS.telemetryPort),
    '--telemetry-interval-ms',
    '50',
    '--data-dir',
    dataDir,
  ];

  if (samplesDir) {
    args.push('--samples-dir', samplesDir);
  }
  if (DEFAULTS.autostartAudio) {
    args.push('--autostart-audio');
  }
  if (DEFAULTS.noAudio) {
    args.push('--no-audio');
  }

  return {
    binaryPath,
    args,
    env: spawnEnv,
    dataDir,
    samplesDir,
    libsDir,
    binaryCandidates,
  };
}

async function ensureDirectoryForFile(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function main() {
  const startedAt = new Date();
  const report = {
    generatedAt: startedAt.toISOString(),
    pass: false,
    config: {
      oscHost: DEFAULTS.oscHost,
      oscPort: DEFAULTS.oscPort,
      telemetryHost: DEFAULTS.telemetryHost,
      telemetryPort: DEFAULTS.telemetryPort,
      timeoutMs: DEFAULTS.timeoutMs,
      noAudio: DEFAULTS.noAudio,
      autostartAudio: DEFAULTS.autostartAudio,
      outputPath: DEFAULTS.outputPath,
      keepTemp: DEFAULTS.keepTemp,
    },
    runtime: {},
    assertions: {},
    telemetry: {
      hello: null,
      helloArgsMap: {},
      totalScans: 0,
      scanStats: computeScanStats([]),
    },
    commandsSent: [],
    process: {},
    logs: {
      stdoutTail: [],
      stderrTail: [],
    },
    errors: [],
  };

  let runtime = null;
  let child = null;
  let commandPort = null;
  let telemetryPort = null;

  const stdoutLines = [];
  const stderrLines = [];
  const telemetryState = {
    hello: null,
    scans: [],
  };

  let resolveHelloWaiter = null;
  let rejectHelloWaiter = null;
  const helloPromise = new Promise((resolve, reject) => {
    resolveHelloWaiter = resolve;
    rejectHelloWaiter = reject;
  });

  const onTelemetryMessage = (message) => {
    if (!message || typeof message.address !== 'string') {
      return;
    }

    if (message.address === '/ec2/hello') {
      const rawArgs = Array.isArray(message.args) ? message.args : [];
      const args = [];
      for (const rawArg of rawArgs) {
        const normalized = normalizeTelemetryArg(rawArg);
        if (typeof normalized === 'string' && normalized.length === 0) {
          continue;
        }
        args.push(normalized);
        if (args.length >= 32) {
          break;
        }
      }
      const hello = {
        timestampMs: Date.now(),
        address: message.address,
        args,
      };
      telemetryState.hello = hello;
      if (resolveHelloWaiter) {
        resolveHelloWaiter(hello);
        resolveHelloWaiter = null;
        rejectHelloWaiter = null;
      }
      return;
    }

    if (message.address !== '/ec2/telemetry/scan') {
      return;
    }

    const args = Array.isArray(message.args) ? message.args : [];
    const playheadNorm = parseOscNumericArg(args[0]);
    const scanHeadNorm = parseOscNumericArg(args[1]);
    const scanRangeNorm = parseOscNumericArg(args[2]);
    if (playheadNorm == null || scanHeadNorm == null || scanRangeNorm == null) {
      return;
    }

    telemetryState.scans.push({
      timestampMs: Date.now(),
      playheadNorm,
      scanHeadNorm,
      scanRangeNorm,
    });
  };

  try {
    runtime = await resolveRuntimeConfig();
    report.runtime = {
      binaryPath: runtime.binaryPath,
      args: runtime.args,
      dataDir: runtime.dataDir,
      samplesDir: runtime.samplesDir || null,
      libsDir: runtime.libsDir || null,
      binaryCandidates: runtime.binaryCandidates,
    };

    telemetryPort = new osc.UDPPort({
      localAddress: DEFAULTS.telemetryHost,
      localPort: DEFAULTS.telemetryPort,
      metadata: true,
    });
    telemetryPort.on('message', onTelemetryMessage);
    await openUdpPort(telemetryPort, 3000);

    commandPort = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: 0,
      remoteAddress: DEFAULTS.oscHost,
      remotePort: DEFAULTS.oscPort,
      metadata: true,
    });
    await openUdpPort(commandPort, 3000);

    child = spawn(runtime.binaryPath, runtime.args, {
      cwd: path.dirname(runtime.binaryPath),
      env: runtime.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    collectProcessLines(child.stdout, stdoutLines, 'stdout');
    collectProcessLines(child.stderr, stderrLines, 'stderr');
    await waitForChildSpawn(child, 3000);

    const helloTimeoutHandle = setTimeout(() => {
      if (rejectHelloWaiter) {
        rejectHelloWaiter(new Error(`telemetry_hello_timeout(${DEFAULTS.timeoutMs}ms)`));
        rejectHelloWaiter = null;
        resolveHelloWaiter = null;
      }
    }, DEFAULTS.timeoutMs);

    const hello = await helloPromise.finally(() => {
      clearTimeout(helloTimeoutHandle);
    });

    report.telemetry.hello = hello;
    report.telemetry.helloArgsMap = parseHelloArgsMap(Array.isArray(hello?.args) ? hello.args : []);

    await waitForScanCount(telemetryState, 4, Math.min(3000, DEFAULTS.timeoutMs));
    const scanStartIndex = telemetryState.scans.length;

    const sendCommand = (address, args) => {
      const payload = { address, args };
      commandPort.send(payload);
      report.commandsSent.push({
        timestampMs: Date.now(),
        address,
        args: args.map((arg) => ({ type: arg.type, value: arg.value })),
      });
    };

    sendCommand('/Amplitude', [{ type: 'f', value: 0.42 }]);
    await sleep(200);
    sendCommand('/transport', [{ type: 'i', value: 1 }]);
    await sleep(300);
    sendCommand('/transport', [{ type: 'i', value: 0 }]);
    await sleep(400);

    const postCommandScans = telemetryState.scans.slice(scanStartIndex);
    report.telemetry.totalScans = telemetryState.scans.length;
    report.telemetry.scanStats = computeScanStats(postCommandScans);

    const aliveAfterCommands = child.exitCode === null && !child.killed;
    const helloObserved = Boolean(report.telemetry.hello);
    const scanObserved = telemetryState.scans.length >= 4;
    const amplitudeDispatched = report.commandsSent.some((entry) => entry.address === '/Amplitude');
    const transportDispatched =
      report.commandsSent.filter((entry) => entry.address === '/transport').length >= 2;
    const transportOneMarker = hasLogLine(stdoutLines, (line) =>
      line.toLowerCase().includes('transport 1'),
    );
    const transportZeroMarker = hasLogLine(stdoutLines, (line) =>
      line.toLowerCase().includes('transport 0'),
    );
    const transportIgnoredNoAudioMarker = hasLogLine(stdoutLines, (line) =>
      line.toLowerCase().includes('ignored /transport 1 because --no-audio is active'),
    );
    const transportEvidence =
      DEFAULTS.noAudio && !DEFAULTS.autostartAudio
        ? transportIgnoredNoAudioMarker
        : transportOneMarker && transportZeroMarker;

    report.assertions = {
      helloObserved,
      scanObserved,
      processAliveAfterCommands: aliveAfterCommands,
      amplitudeCommandDispatched: amplitudeDispatched,
      transportCommandsDispatched: transportDispatched,
      transportEvidence,
      transportOneMarker,
      transportZeroMarker,
      transportIgnoredNoAudioMarker,
    };

    report.pass =
      helloObserved &&
      scanObserved &&
      aliveAfterCommands &&
      amplitudeDispatched &&
      transportDispatched &&
      transportEvidence;
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    const stopResult = await stopChildProcess(child, 4500);
    report.process = {
      pid: child?.pid ?? null,
      exitCode: stopResult.exitCode,
      signal: stopResult.signal,
      forcedKill: stopResult.forced,
    };

    closeUdpPort(commandPort);
    closeUdpPort(telemetryPort);

    report.logs.stdoutTail = stdoutLines.slice(-120);
    report.logs.stderrTail = stderrLines.slice(-120);

    await ensureDirectoryForFile(DEFAULTS.outputPath);
    await fsp.writeFile(DEFAULTS.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    if (runtime?.dataDir && !DEFAULTS.keepTemp) {
      try {
        await fsp.rm(runtime.dataDir, { recursive: true, force: true });
      } catch {
        // cleanup best-effort only
      }
    }
  }

  console.log(`[headless-smoke] report=${DEFAULTS.outputPath} pass=${Boolean(report.pass)}`);
  if (!report.pass) {
    const details =
      report.errors.length > 0
        ? report.errors.join('; ')
        : `assertions_failed=${JSON.stringify(report.assertions)}`;
    console.error(`[headless-smoke] failed: ${details}`);
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[headless-smoke] fatal: ${message}`);
  process.exit(1);
});
