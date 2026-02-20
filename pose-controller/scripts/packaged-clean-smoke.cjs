#!/usr/bin/env node

const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const osc = require('osc');

const DEFAULTS = {
  appPath: resolvePathFromEnv(process.env.PACKAGED_SMOKE_APP_PATH, process.cwd()),
  oscHost: process.env.PACKAGED_SMOKE_OSC_HOST || '127.0.0.1',
  oscPort: parseBoundedInt(process.env.PACKAGED_SMOKE_OSC_PORT, 19447, 1, 65535),
  telemetryHost: process.env.PACKAGED_SMOKE_TELEMETRY_HOST || '127.0.0.1',
  telemetryPort: parseBoundedInt(process.env.PACKAGED_SMOKE_TELEMETRY_PORT, 19448, 1, 65535),
  timeoutMs: parseBoundedInt(process.env.PACKAGED_SMOKE_TIMEOUT_MS, 30000, 5000, 180000),
  noAudio: parseBooleanEnv(process.env.PACKAGED_SMOKE_NO_AUDIO, false),
  autostartAudio: parseBooleanEnv(process.env.PACKAGED_SMOKE_AUTOSTART_AUDIO, false),
  keepTemp: parseBooleanEnv(process.env.PACKAGED_SMOKE_KEEP_TEMP, false),
  outputPath: resolvePathFromEnv(
    process.env.PACKAGED_SMOKE_OUTPUT || 'docs/packaged-clean-smoke-latest.json',
    path.resolve(__dirname, '..'),
  ),
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

async function captureScanWindow(telemetryState, durationMs) {
  const startIndex = telemetryState.scans.length;
  const startedAtMs = Date.now();
  await sleep(durationMs);
  const scans = telemetryState.scans.slice(startIndex);
  return {
    startedAtMs,
    durationMs,
    count: scans.length,
    stats: computeScanStats(scans),
    sample: scans.slice(0, 12),
  };
}

async function stopChildProcess(child, timeoutMs = 5000) {
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

async function ensureDirectoryForFile(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function resolveFirstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      // continue searching
    }
  }
  return '';
}

async function collectRebuiltAppCandidates(poseControllerRoot) {
  try {
    const entries = await fsp.readdir(poseControllerRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('release-artifacts-rebuilt'))
      .map((entry) => path.resolve(poseControllerRoot, entry.name, 'win-unpacked', 'GranuPose.exe'))
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return [];
  }
}

async function resolvePackagedAppPath() {
  const poseControllerRoot = path.resolve(__dirname, '..');
  const rebuiltCandidates = await collectRebuiltAppCandidates(poseControllerRoot);
  const candidates = [
    DEFAULTS.appPath,
    path.resolve(poseControllerRoot, 'release-artifacts', 'win-unpacked', 'GranuPose.exe'),
    path.resolve(poseControllerRoot, 'release', 'win-unpacked', 'GranuPose.exe'),
    ...rebuiltCandidates,
  ];
  const appPath = await resolveFirstExistingPath(candidates);
  if (!appPath) {
    throw new Error(`Packaged app executable not found. Checked: ${candidates.join(' | ')}`);
  }
  return appPath;
}

async function main() {
  const startedAt = new Date();
  const report = {
    generatedAt: startedAt.toISOString(),
    pass: false,
    config: {
      appPath: '',
      oscHost: DEFAULTS.oscHost,
      oscPort: DEFAULTS.oscPort,
      telemetryHost: DEFAULTS.telemetryHost,
      telemetryPort: DEFAULTS.telemetryPort,
      timeoutMs: DEFAULTS.timeoutMs,
      noAudio: DEFAULTS.noAudio,
      autostartAudio: DEFAULTS.autostartAudio,
      keepTemp: DEFAULTS.keepTemp,
      outputPath: DEFAULTS.outputPath,
    },
    runtime: {
      cleanProfileRoot: '',
      engineDataDir: '',
      staticWavPath: '',
    },
    telemetry: {
      hello: null,
      helloArgsMap: {},
      totalScans: 0,
      baselineWindow: null,
      transportOnWindow: null,
      postTransportWindow: null,
    },
    commandsSent: [],
    assertions: {},
    process: {},
    logs: {
      stdoutTail: [],
      stderrTail: [],
    },
    errors: [],
  };

  let appPath = '';
  let appProc = null;
  let commandPort = null;
  let telemetryPort = null;
  let cleanProfileRoot = '';

  const stdoutLines = [];
  const stderrLines = [];
  const telemetryState = {
    hello: null,
    scans: [],
  };

  let resolveHelloWaiter = null;
  const helloPromise = new Promise((resolve) => {
    resolveHelloWaiter = resolve;
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
        if (args.length >= 48) {
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
    appPath = await resolvePackagedAppPath();
    report.config.appPath = appPath;

    cleanProfileRoot = path.resolve(
      os.tmpdir(),
      `granuPose-packaged-smoke-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    );
    const engineDataDir = path.resolve(cleanProfileRoot, 'engine-data');
    await fsp.mkdir(engineDataDir, { recursive: true });
    report.runtime.cleanProfileRoot = cleanProfileRoot;
    report.runtime.engineDataDir = engineDataDir;

    const staticWavCandidate = path.resolve(path.dirname(appPath), 'resources', 'ec2', 'samples', '440sine48k.wav');
    try {
      await fsp.access(staticWavCandidate);
      report.runtime.staticWavPath = staticWavCandidate;
    } catch {
      report.runtime.staticWavPath = '';
    }

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

    const appEnv = {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '1',
      GRANUPOSE_ENGINE_AUTOSTART: '1',
      GRANUPOSE_ENGINE_AUTOSTART_AUDIO: DEFAULTS.autostartAudio ? '1' : '0',
      GRANUPOSE_ENGINE_NO_AUDIO: DEFAULTS.noAudio ? '1' : '0',
      GRANUPOSE_ENGINE_OSC_HOST: DEFAULTS.oscHost,
      GRANUPOSE_ENGINE_OSC_PORT: String(DEFAULTS.oscPort),
      GRANUPOSE_ENGINE_TELEMETRY_HOST: DEFAULTS.telemetryHost,
      GRANUPOSE_ENGINE_TELEMETRY_PORT: String(DEFAULTS.telemetryPort),
      GRANUPOSE_ENGINE_DATA_DIR: engineDataDir,
    };
    delete appEnv.ELECTRON_RUN_AS_NODE;
    if (report.runtime.staticWavPath) {
      appEnv.GRANUPOSE_STATIC_WAV_PATH = report.runtime.staticWavPath;
    }

    const appStartedAtMs = Date.now();
    appProc = spawn(appPath, [], {
      cwd: path.dirname(appPath),
      env: appEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    collectProcessLines(appProc.stdout, stdoutLines, 'stdout');
    collectProcessLines(appProc.stderr, stderrLines, 'stderr');

    const appExitBeforeHelloPromise = new Promise((resolve) => {
      appProc.once('exit', (exitCode, signal) => {
        resolve({
          kind: 'exit',
          exitCode: typeof exitCode === 'number' ? exitCode : null,
          signal: signal || null,
        });
      });
    });
    const helloResult = await Promise.race([
      helloPromise.then((hello) => ({ kind: 'hello', hello })),
      appExitBeforeHelloPromise,
      new Promise((resolve) =>
        setTimeout(() => resolve({ kind: 'timeout' }), DEFAULTS.timeoutMs),
      ),
    ]);
    if (helloResult.kind === 'timeout') {
      throw new Error(`telemetry_hello_timeout(${DEFAULTS.timeoutMs}ms)`);
    }
    if (helloResult.kind === 'exit') {
      throw new Error(
        `app_exited_before_hello(exitCode=${helloResult.exitCode},signal=${helloResult.signal || 'none'})`,
      );
    }

    const hello = helloResult.hello;
    const helloDelayMs = Number(hello?.timestampMs || Date.now()) - appStartedAtMs;
    report.telemetry.hello = hello;
    report.telemetry.helloArgsMap = parseHelloArgsMap(Array.isArray(hello?.args) ? hello.args : []);

    const sendCommand = (address, args, note) => {
      const payload = { address, args };
      const sentAtMs = Date.now();
      commandPort.send(payload);
      report.commandsSent.push({
        timestampMs: sentAtMs,
        note: note || '',
        address,
        args: args.map((arg) => ({ type: arg.type, value: arg.value })),
      });
      return sentAtMs;
    };

    await waitForScanCount(telemetryState, 6, Math.min(5000, DEFAULTS.timeoutMs));
    report.telemetry.baselineWindow = await captureScanWindow(telemetryState, 900);

    sendCommand('/Amplitude', [{ type: 'f', value: 0.42 }], 'b1:amplitude');
    await sleep(150);
    sendCommand('/ScanSpeed', [{ type: 'f', value: 0.65 }], 'b1:scanSpeed');
    await sleep(200);

    const transportOnSentAtMs = sendCommand('/transport', [{ type: 'i', value: 1 }], 'c1:transportOn');
    report.telemetry.transportOnWindow = await captureScanWindow(telemetryState, 1800);
    sendCommand('/transport', [{ type: 'i', value: 0 }], 'c1:transportOff');
    report.telemetry.postTransportWindow = await captureScanWindow(telemetryState, 900);
    report.telemetry.totalScans = telemetryState.scans.length;

    const firstScanAfterTransport = telemetryState.scans.find(
      (scan) => Number(scan.timestampMs) >= transportOnSentAtMs,
    );
    const firstTelemetryAfterTransportMs = firstScanAfterTransport
      ? Number(firstScanAfterTransport.timestampMs) - transportOnSentAtMs
      : null;

    const helloObserved = Boolean(report.telemetry.hello);
    const a1Within5s = Number.isFinite(helloDelayMs) && helloDelayMs <= 5000;
    const scansObserved = telemetryState.scans.length >= 10;
    const amplitudeSent = report.commandsSent.some((entry) => entry.address === '/Amplitude');
    const scanSpeedSent = report.commandsSent.some((entry) => entry.address === '/ScanSpeed');
    const transportSent =
      report.commandsSent.filter((entry) => entry.address === '/transport').length >= 2;
    const transportMovementDetected =
      (report.telemetry.transportOnWindow?.stats?.playheadSpan || 0) > 0.01 ||
      (report.telemetry.transportOnWindow?.stats?.scanHeadSpan || 0) > 0.01;
    const samplesDirFromHello = String(report.telemetry.helloArgsMap.samplesDir || '');
    const packagedSamplesPathResolved =
      samplesDirFromHello.toLowerCase().includes('resources') &&
      samplesDirFromHello.toLowerCase().includes(`${path.sep}ec2${path.sep}`.toLowerCase());
    const processAliveAfterCommands = appProc.exitCode === null && !appProc.killed;

    report.assertions = {
      helloObserved,
      a1Within5s,
      helloDelayMs,
      scansObserved,
      amplitudeSent,
      scanSpeedSent,
      transportSent,
      transportMovementDetected,
      packagedSamplesPathResolved,
      firstTelemetryAfterTransportMs,
      processAliveAfterCommands,
    };

    report.pass =
      helloObserved &&
      a1Within5s &&
      scansObserved &&
      amplitudeSent &&
      scanSpeedSent &&
      transportSent &&
      transportMovementDetected &&
      packagedSamplesPathResolved &&
      processAliveAfterCommands;
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    const stopResult = await stopChildProcess(appProc, 8000);
    report.process = {
      pid: appProc?.pid ?? null,
      exitCode: stopResult.exitCode,
      signal: stopResult.signal,
      forcedKill: stopResult.forced,
    };

    closeUdpPort(commandPort);
    closeUdpPort(telemetryPort);

    report.logs.stdoutTail = stdoutLines.slice(-160);
    report.logs.stderrTail = stderrLines.slice(-160);

    await ensureDirectoryForFile(DEFAULTS.outputPath);
    await fsp.writeFile(DEFAULTS.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    if (cleanProfileRoot && !DEFAULTS.keepTemp) {
      try {
        await fsp.rm(cleanProfileRoot, { recursive: true, force: true });
      } catch {
        // cleanup best-effort only
      }
    }
  }

  console.log(`[packaged-clean-smoke] report=${DEFAULTS.outputPath} pass=${Boolean(report.pass)}`);
  if (!report.pass) {
    const details =
      report.errors.length > 0
        ? report.errors.join('; ')
        : `assertions_failed=${JSON.stringify(report.assertions)}`;
    console.error(`[packaged-clean-smoke] failed: ${details}`);
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[packaged-clean-smoke] fatal: ${message}`);
  process.exit(1);
});
