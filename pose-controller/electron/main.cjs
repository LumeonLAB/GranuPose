const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const osc = require('osc');
const JZZ = require('jzz');

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

const OSC_DEFAULTS = {
  targetHost: process.env.OSC_TARGET_HOST || '127.0.0.1',
  targetPort: parsePort(process.env.OSC_TARGET_PORT, 16447),
  channelPrefix: (process.env.OSC_CHANNEL_PREFIX || '/pose/out').replace(/\/+$/, ''),
  channelCount: parseCount(process.env.OSC_CHANNEL_COUNT, 16),
};

const MIDI_DEFAULTS = {
  channelCount: parseCount(process.env.MIDI_CHANNEL_COUNT, 16),
  deviceId: process.env.MIDI_DEVICE_ID || process.env.MIDI_DEVICE_NAME || '',
  midiChannel: parseBoundedInt(process.env.MIDI_CHANNEL, 1, 1, 16),
  ccStart: parseBoundedInt(process.env.MIDI_CC_START, 1, 0, 127),
};

const TELEMETRY_DEFAULTS = {
  listenHost: process.env.TELEMETRY_LISTEN_HOST || '0.0.0.0',
  listenPort: parsePort(process.env.TELEMETRY_LISTEN_PORT, 16448),
  helloAddress: process.env.TELEMETRY_HELLO_ADDRESS || '/ec2/hello',
  scanAddress: process.env.TELEMETRY_SCAN_ADDRESS || '/ec2/telemetry/scan',
};

const ENGINE_DEFAULTS = {
  oscHost: process.env.GRANUPOSE_ENGINE_OSC_HOST || '127.0.0.1',
  oscPort: parsePort(process.env.GRANUPOSE_ENGINE_OSC_PORT, 16447),
  telemetryHost: process.env.GRANUPOSE_ENGINE_TELEMETRY_HOST || '127.0.0.1',
  telemetryPort: parsePort(process.env.GRANUPOSE_ENGINE_TELEMETRY_PORT, 16448),
  autoStart:
    parseBooleanEnv(process.env.GRANUPOSE_ENGINE_AUTOSTART) ?? true,
  autoStartAudio: parseBooleanEnv(process.env.GRANUPOSE_ENGINE_AUTOSTART_AUDIO) ?? true,
  noAudio: parseBooleanEnv(process.env.GRANUPOSE_ENGINE_NO_AUDIO) ?? false,
};

const ENGINE_WATCHDOG_DEFAULTS = {
  autoRestart:
    parseBooleanEnv(process.env.GRANUPOSE_ENGINE_WATCHDOG_RESTART) ??
    true,
  restartBaseDelayMs: parseBoundedInt(
    process.env.GRANUPOSE_ENGINE_RESTART_BASE_DELAY_MS,
    1000,
    250,
    60000,
  ),
  restartMaxDelayMs: parseBoundedInt(
    process.env.GRANUPOSE_ENGINE_RESTART_MAX_DELAY_MS,
    30000,
    500,
    300000,
  ),
  restartMaxAttempts: parseBoundedInt(
    process.env.GRANUPOSE_ENGINE_RESTART_MAX_ATTEMPTS,
    5,
    1,
    25,
  ),
  restartBackoffResetMs: parseBoundedInt(
    process.env.GRANUPOSE_ENGINE_RESTART_BACKOFF_RESET_MS,
    120000,
    10000,
    900000,
  ),
};

const ENGINE_LOG_BUFFER_LIMIT = parseBoundedInt(
  process.env.GRANUPOSE_ENGINE_LOG_LIMIT,
  400,
  50,
  2000,
);

const VALIDATION_MODE =
  typeof process.env.GRANUPOSE_VALIDATION_MODE === 'string'
    ? process.env.GRANUPOSE_VALIDATION_MODE.trim().toLowerCase()
    : '';
const STEP1_VALIDATION_ENABLED = VALIDATION_MODE === 'step1';
const STEP2_VALIDATION_ENABLED = VALIDATION_MODE === 'step2';
const STEP3_VALIDATION_ENABLED = VALIDATION_MODE === 'step3';
const STEP4_VALIDATION_ENABLED = VALIDATION_MODE === 'step4';
const VALIDATION_ENABLED =
  STEP1_VALIDATION_ENABLED ||
  STEP2_VALIDATION_ENABLED ||
  STEP3_VALIDATION_ENABLED ||
  STEP4_VALIDATION_ENABLED;
const STEP1_VALIDATION_TIMEOUT_MS = parseBoundedInt(
  process.env.GRANUPOSE_VALIDATION_TIMEOUT_MS,
  20000,
  3000,
  120000,
);
const STEP1_VALIDATION_POLL_INTERVAL_MS = parseBoundedInt(
  process.env.GRANUPOSE_VALIDATION_POLL_INTERVAL_MS,
  150,
  50,
  2000,
);
const STEP1_VALIDATION_HIDE_WINDOW =
  parseBooleanEnv(process.env.GRANUPOSE_VALIDATION_HIDE_WINDOW) ??
  VALIDATION_ENABLED;
const VALIDATION_REPORT_PATH_OVERRIDE = resolvePathFromEnv(
  process.env.GRANUPOSE_VALIDATION_REPORT_PATH,
);

const oscState = {
  port: null,
  ready: false,
  opening: null,
  targetHost: OSC_DEFAULTS.targetHost,
  targetPort: OSC_DEFAULTS.targetPort,
  channelPrefix: OSC_DEFAULTS.channelPrefix,
  channelCount: OSC_DEFAULTS.channelCount,
  lastError: null,
};

const midiState = {
  engine: null,
  output: null,
  ready: false,
  channelCount: MIDI_DEFAULTS.channelCount,
  deviceId: MIDI_DEFAULTS.deviceId,
  midiChannel: MIDI_DEFAULTS.midiChannel,
  ccStart: MIDI_DEFAULTS.ccStart,
  lastError: null,
};

const telemetryState = {
  port: null,
  ready: false,
  listenHost: TELEMETRY_DEFAULTS.listenHost,
  listenPort: TELEMETRY_DEFAULTS.listenPort,
  helloAddress: TELEMETRY_DEFAULTS.helloAddress,
  scanAddress: TELEMETRY_DEFAULTS.scanAddress,
  lastHello: null,
  lastScan: null,
  scanBuffer: [],
  lastError: null,
};

const engineState = {
  child: null,
  status: 'stopped',
  pid: null,
  binaryPath: null,
  args: [],
  lastError: null,
  startedAtMs: null,
  stoppedAtMs: null,
  stopping: false,
  logBuffer: [],
  allowAutoRestart: false,
  restartTimer: null,
  restartAttempts: 0,
  lastUnexpectedExitAtMs: null,
};

let quitInProgress = false;
let validationHarnessInProgress = false;
let mainWindowRef = null;

function parsePort(rawValue, fallback) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.trunc(parsed);
  return Math.max(1, Math.min(65535, rounded));
}

function parseCount(rawValue, fallback) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.trunc(parsed);
  return Math.max(1, Math.min(32, rounded));
}

function parseBoundedInt(rawValue, fallback, min, max) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.trunc(parsed);
  return Math.max(min, Math.min(max, rounded));
}

function parseBooleanEnv(rawValue) {
  if (typeof rawValue !== 'string') {
    return null;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return null;
}

function normalizeHost(rawValue) {
  if (typeof rawValue !== 'string') {
    return null;
  }

  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

function parseCommandLines(stdout) {
  if (typeof stdout !== 'string') {
    return [];
  }

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function dedupeNames(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) {
      continue;
    }

    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(trimmed);
  }

  return result;
}

function runCommand(command, args, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(typeof stdout === 'string' ? stdout : '');
      },
    );
  });
}

function createSystemAudioOutputId(name, index) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `system:${slug || 'output'}:${index + 1}`;
}

async function listWindowsAudioOutputNames() {
  const powershellScripts = [
    // Endpoint list (usually closest to what users see in system sound settings).
    "Get-PnpDevice -Class AudioEndpoint -PresentOnly | Where-Object { $_.Status -eq 'OK' } | ForEach-Object { $_.FriendlyName }",
    // Fallback for environments where PnpDevice cmdlets are unavailable.
    "Get-CimInstance Win32_SoundDevice | ForEach-Object { $_.Name }",
  ];

  for (const script of powershellScripts) {
    try {
      const stdout = await runCommand('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ]);
      const names = dedupeNames(parseCommandLines(stdout));
      if (names.length > 0) {
        return names;
      }
    } catch {
      // Try the next fallback command.
    }
  }

  return [];
}

async function listLinuxAudioOutputNames() {
  try {
    const stdout = await runCommand('pactl', ['list', 'short', 'sinks']);
    const names = dedupeNames(
      parseCommandLines(stdout).map((line) => {
        const parts = line.split(/\t+/);
        return (parts[1] || parts[0] || '').trim();
      }),
    );
    if (names.length > 0) {
      return names;
    }
  } catch {
    // Ignore and fall back below.
  }

  return [];
}

async function listMacAudioOutputNames() {
  try {
    const stdout = await runCommand('system_profiler', ['SPAudioDataType', '-detailLevel', 'mini'], 6000);
    const names = dedupeNames(
      parseCommandLines(stdout)
        .filter((line) => /output|speaker|headphone|line out/i.test(line))
        .map((line) => line.replace(/:$/, '').trim()),
    );
    if (names.length > 0) {
      return names;
    }
  } catch {
    // Ignore and use empty fallback.
  }

  return [];
}

async function listSystemAudioOutputNames() {
  let names = [];

  if (process.platform === 'win32') {
    names = await listWindowsAudioOutputNames();
  } else if (process.platform === 'linux') {
    names = await listLinuxAudioOutputNames();
  } else if (process.platform === 'darwin') {
    names = await listMacAudioOutputNames();
  }

  return dedupeNames(names);
}

function getDefaultStaticWavCandidatePaths() {
  const fromEnv =
    typeof process.env.GRANUPOSE_STATIC_WAV_PATH === 'string'
      ? process.env.GRANUPOSE_STATIC_WAV_PATH.trim()
      : '';
  const staticRelativePath = path.join(
    'EmissionControl2',
    'externalResources',
    'samples',
    '440sine48k.wav',
  );
  const candidates = [
    fromEnv,
    path.resolve(app.getAppPath(), '..', staticRelativePath),
    path.resolve(app.getAppPath(), '..', 'engine-resources', 'samples', '440sine48k.wav'),
    path.resolve(__dirname, '..', '..', staticRelativePath),
    path.resolve(__dirname, '..', '..', 'engine-resources', 'samples', '440sine48k.wav'),
    path.resolve(process.cwd(), staticRelativePath),
    path.resolve(process.cwd(), 'engine-resources', 'samples', '440sine48k.wav'),
    path.resolve(process.resourcesPath, staticRelativePath),
    path.resolve(process.resourcesPath, 'ec2', 'samples', '440sine48k.wav'),
  ];

  return dedupeNames(candidates);
}

async function resolveDefaultStaticWavPath() {
  const candidatePaths = getDefaultStaticWavCandidatePaths();
  for (const candidatePath of candidatePaths) {
    try {
      await fs.access(candidatePath);
      return candidatePath;
    } catch {
      // Continue searching candidate paths.
    }
  }

  return '';
}

function createEngineLogEntry(source, line) {
  return {
    timestampMs: Date.now(),
    source,
    line,
  };
}

function broadcastEngineStatus() {
  const payload = createEngineStatusResponse(true);
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('granuPose:engine:status', payload);
    }
  }
}

function broadcastEngineLog(entry) {
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('granuPose:engine:log', entry);
    }
  }
}

function appendEngineLog(source, line) {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (!trimmed) {
    return;
  }

  const entry = createEngineLogEntry(source, trimmed);
  engineState.logBuffer.push(entry);
  if (engineState.logBuffer.length > ENGINE_LOG_BUFFER_LIMIT) {
    engineState.logBuffer.splice(0, engineState.logBuffer.length - ENGINE_LOG_BUFFER_LIMIT);
  }

  broadcastEngineLog(entry);
}

function clearEngineRestartTimer() {
  if (engineState.restartTimer) {
    clearTimeout(engineState.restartTimer);
    engineState.restartTimer = null;
  }
}

function resetEngineRestartBackoff(reason = '') {
  clearEngineRestartTimer();
  engineState.restartAttempts = 0;
  engineState.lastUnexpectedExitAtMs = null;
  if (reason) {
    appendEngineLog('system', `Engine restart backoff reset (${reason}).`);
  }
}

function getEngineRestartDelayMs(attemptNumber) {
  const exponentialDelay =
    ENGINE_WATCHDOG_DEFAULTS.restartBaseDelayMs * Math.pow(2, Math.max(0, attemptNumber - 1));
  return Math.min(ENGINE_WATCHDOG_DEFAULTS.restartMaxDelayMs, exponentialDelay);
}

function scheduleEngineRestart(exitMessage) {
  if (quitInProgress) {
    return;
  }

  if (!engineState.allowAutoRestart) {
    appendEngineLog('system', 'Engine auto-restart skipped (manual stop policy active).');
    return;
  }

  if (!ENGINE_WATCHDOG_DEFAULTS.autoRestart) {
    appendEngineLog('system', 'Engine auto-restart skipped (watchdog disabled).');
    return;
  }

  const now = Date.now();
  if (
    !engineState.lastUnexpectedExitAtMs ||
    now - engineState.lastUnexpectedExitAtMs > ENGINE_WATCHDOG_DEFAULTS.restartBackoffResetMs
  ) {
    engineState.restartAttempts = 0;
  }
  engineState.lastUnexpectedExitAtMs = now;

  if (engineState.restartAttempts >= ENGINE_WATCHDOG_DEFAULTS.restartMaxAttempts) {
    const finalMessage = `Engine restart watchdog exhausted (${ENGINE_WATCHDOG_DEFAULTS.restartMaxAttempts} attempts).`;
    appendEngineLog('stderr', `${finalMessage} Last exit: ${exitMessage}`);
    engineState.allowAutoRestart = false;
    return;
  }

  engineState.restartAttempts += 1;
  const attempt = engineState.restartAttempts;
  const delayMs = getEngineRestartDelayMs(attempt);
  appendEngineLog(
    'system',
    `Scheduling engine restart attempt ${attempt}/${ENGINE_WATCHDOG_DEFAULTS.restartMaxAttempts} in ${delayMs}ms (${exitMessage})`,
  );

  clearEngineRestartTimer();
  engineState.restartTimer = setTimeout(async () => {
    engineState.restartTimer = null;

    if (quitInProgress || !engineState.allowAutoRestart) {
      return;
    }

    appendEngineLog(
      'system',
      `Executing engine restart attempt ${attempt}/${ENGINE_WATCHDOG_DEFAULTS.restartMaxAttempts}.`,
    );
    const restartResult = await startEngine({ preserveWatchdogBackoff: true, trigger: 'watchdog' });
    if (!restartResult.ok) {
      const reason = restartResult.error || 'watchdog_restart_start_failed';
      appendEngineLog('stderr', `Engine restart attempt ${attempt} failed: ${reason}`);
      scheduleEngineRestart(`watchdog start failure: ${reason}`);
    }
  }, delayMs);
}

function setEngineStatus(nextStatus, options = {}) {
  engineState.status = nextStatus;

  if (Object.prototype.hasOwnProperty.call(options, 'pid')) {
    engineState.pid = options.pid;
  }

  if (Object.prototype.hasOwnProperty.call(options, 'binaryPath')) {
    engineState.binaryPath = options.binaryPath;
  }

  if (Object.prototype.hasOwnProperty.call(options, 'args')) {
    engineState.args = Array.isArray(options.args) ? options.args : [];
  }

  if (Object.prototype.hasOwnProperty.call(options, 'error')) {
    engineState.lastError = options.error;
  }

  if (nextStatus === 'running') {
    engineState.startedAtMs = Date.now();
    engineState.stoppedAtMs = null;
  }

  if (nextStatus === 'stopped' || nextStatus === 'error') {
    engineState.stoppedAtMs = Date.now();
  }

  broadcastEngineStatus();
}

function createEngineStatusResponse(ok, error) {
  return {
    ok,
    status: engineState.status,
    pid: engineState.pid,
    binaryPath: engineState.binaryPath || undefined,
    args: Array.isArray(engineState.args) ? [...engineState.args] : [],
    startedAtMs: engineState.startedAtMs ?? undefined,
    stoppedAtMs: engineState.stoppedAtMs ?? undefined,
    autoStartEnabled: ENGINE_DEFAULTS.autoStart,
    autoRestartEnabled: Boolean(
      engineState.allowAutoRestart && ENGINE_WATCHDOG_DEFAULTS.autoRestart,
    ),
    restartAttempts: engineState.restartAttempts,
    restartMaxAttempts: ENGINE_WATCHDOG_DEFAULTS.restartMaxAttempts,
    lastError: error || engineState.lastError || undefined,
  };
}

function getEngineLogs(payload = {}) {
  const limit = parseBoundedInt(payload.limit, 200, 1, ENGINE_LOG_BUFFER_LIMIT);
  return {
    ok: true,
    entries: engineState.logBuffer.slice(-limit),
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nowIso() {
  return new Date().toISOString();
}

function createValidationReportPath(stepName = 'step') {
  const normalizedStepName =
    typeof stepName === 'string' && stepName.trim().length > 0
      ? stepName.trim().toLowerCase()
      : 'step';
  if (VALIDATION_REPORT_PATH_OVERRIDE) {
    return VALIDATION_REPORT_PATH_OVERRIDE;
  }

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const filename = `standalone-${normalizedStepName}-validation-${stamp}.json`;
  const baseDir =
    path.basename(process.cwd()).toLowerCase() === 'pose-controller'
      ? path.resolve(process.cwd(), 'docs')
      : path.resolve(process.cwd(), 'pose-controller', 'docs');
  return path.resolve(baseDir, filename);
}

async function writeValidationReport(stepName, report) {
  const reportPath = createValidationReportPath(stepName);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return reportPath;
}

async function runRendererValidationAction(window, action, payload = {}) {
  const actionJson = JSON.stringify(action);
  const payloadJson = JSON.stringify(payload);
  return window.webContents.executeJavaScript(
    `
      (async () => {
        const action = ${actionJson};
        const payload = ${payloadJson};
        const normalize = (value) => (typeof value === 'string' ? value.trim() : '');
        const byText = (nodes, predicate) => nodes.find((node) => predicate(normalize(node.textContent)));
        const findSectionLabelInput = (sectionSelector, labelNeedle) => {
          const section = document.querySelector(sectionSelector);
          if (!section) {
            return null;
          }
          const labels = Array.from(section.querySelectorAll('label'));
          const needle = String(labelNeedle || '').trim().toLowerCase();
          const label = labels.find((candidate) =>
            normalize(candidate.textContent).toLowerCase().includes(needle),
          );
          return label ? label.querySelector('input, select, textarea') : null;
        };
        const findLabelInput = (labelNeedle) => {
          return findSectionLabelInput('section.output-panel', labelNeedle);
        };
        const findAudioLabelInput = (labelNeedle) => {
          return findSectionLabelInput('section[aria-label="EC2 Audio Bridge"]', labelNeedle);
        };
        const getOutputPanel = () => document.querySelector('section.output-panel');
        const getEnginePanel = () => document.querySelector('section[aria-label="Managed Engine Control"]');
        const getAudioPanel = () => document.querySelector('section[aria-label="EC2 Audio Bridge"]');
        const findEngineButton = (commandName) => {
          const panel = getEnginePanel();
          if (!panel) {
            return null;
          }
          const needle = String(commandName || '').trim().toLowerCase();
          const buttons = Array.from(panel.querySelectorAll('button'));
          return byText(buttons, (text) => text.toLowerCase() === needle) || null;
        };
        const setInputLikeValue = (element, nextValue) => {
          if (!element) {
            return;
          }
          const tagName = String(element.tagName || '').toLowerCase();
          if (tagName === 'input') {
            const descriptor = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              'value',
            );
            if (descriptor && typeof descriptor.set === 'function') {
              descriptor.set.call(element, String(nextValue));
            } else {
              element.value = String(nextValue);
            }
          } else if (tagName === 'textarea') {
            const descriptor = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype,
              'value',
            );
            if (descriptor && typeof descriptor.set === 'function') {
              descriptor.set.call(element, String(nextValue));
            } else {
              element.value = String(nextValue);
            }
          } else {
            element.value = String(nextValue);
          }
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const findStartupTransportToggle = () => {
          const labels = Array.from(document.querySelectorAll('section.output-panel label'));
          const label = labels.find((candidate) =>
            normalize(candidate.textContent).toLowerCase().includes('startup auto transport'),
          );
          return label ? label.querySelector('input[type="checkbox"]') : null;
        };
        const findAudioTransportButton = (state) => {
          const panel = getAudioPanel();
          if (!panel) {
            return null;
          }
          const needle = String(state || '').trim().toLowerCase() === 'off' ? 'audio off' : 'audio on';
          const buttons = Array.from(panel.querySelectorAll('button'));
          return byText(buttons, (text) => text.toLowerCase() === needle) || null;
        };
        const findAudioRecordButton = (state) => {
          const panel = getAudioPanel();
          if (!panel) {
            return null;
          }
          const needle = String(state || '').trim().toLowerCase() === 'stop' ? 'record stop' : 'record start';
          const buttons = Array.from(panel.querySelectorAll('button'));
          return byText(buttons, (text) => text.toLowerCase() === needle) || null;
        };
        const readSnapshot = () => {
          const managedToggle = findLabelInput('managed local engine');
          const protocolSelect = findLabelInput('protocol');
          const startupAutoTransportToggle = findStartupTransportToggle();
          const hostInput = findLabelInput('osc target ip');
          const portInput = findLabelInput('osc target port');
          const recordFileNameInput = findAudioLabelInput('record file name');
          const outputFolderInput = findAudioLabelInput('output folder');
          const outputPanel = getOutputPanel();
          const mappingNotes = Array.from(
            outputPanel ? outputPanel.querySelectorAll('.mapping-note') : [],
          );
          const lockModeNote =
            byText(mappingNotes, (text) => /managed mode lock active|remote mode active/i.test(text)) || null;
          const startupPolicyNote =
            byText(mappingNotes, (text) => text.toLowerCase().includes('startup transport policy')) || null;
          const engineStatusChip = document.querySelector(
            'section[aria-label="Managed Engine Control"] .engine-status-chip',
          );
          const bridgeMode = document.querySelector('section[aria-label="Managed Engine Control"] .bridge-mode');
          const feedback = document.querySelector(
            'section[aria-label="Managed Engine Control"] .audio-bridge-feedback',
          );
          const startupAuditLines = Array.from(
            document.querySelectorAll('section[aria-label="Managed Engine Control"] .startup-audit-trail div'),
          )
            .map((node) => normalize(node.textContent))
            .filter((line) => line.length > 0)
            .slice(-8);
          const audioFeedback = document.querySelector(
            'section[aria-label="EC2 Audio Bridge"] .audio-bridge-feedback',
          );
          return {
            timestampMs: Date.now(),
            protocolValue: protocolSelect ? String(protocolSelect.value || '') : '',
            managedChecked: Boolean(managedToggle && managedToggle.checked),
            startupAutoTransportChecked: Boolean(
              startupAutoTransportToggle && startupAutoTransportToggle.checked,
            ),
            hostValue: hostInput ? String(hostInput.value || '') : '',
            hostDisabled: Boolean(hostInput && hostInput.disabled),
            portValue: portInput ? String(portInput.value || '') : '',
            portDisabled: Boolean(portInput && portInput.disabled),
            modeNote: lockModeNote ? normalize(lockModeNote.textContent) : '',
            startupPolicyNote: startupPolicyNote ? normalize(startupPolicyNote.textContent) : '',
            bridgeMode: bridgeMode ? normalize(bridgeMode.textContent) : '',
            engineStatusText: engineStatusChip ? normalize(engineStatusChip.textContent) : '',
            engineFeedbackText: feedback ? normalize(feedback.textContent) : '',
            audioBridgeFeedbackText: audioFeedback ? normalize(audioFeedback.textContent) : '',
            recordFileNameValue: recordFileNameInput ? String(recordFileNameInput.value || '') : '',
            outputFolderValue: outputFolderInput ? String(outputFolderInput.value || '') : '',
            startupAuditTrail: startupAuditLines,
          };
        };

        if (action === 'ready') {
          return {
            ready: Boolean(findLabelInput('managed local engine') && findEngineButton('start') && window.granuPose?.engine),
            snapshot: readSnapshot(),
          };
        }

        if (action === 'snapshot') {
          return readSnapshot();
        }

        if (action === 'setManaged') {
          const managedToggle = findLabelInput('managed local engine');
          if (!managedToggle) {
            return { ok: false, error: 'managed_toggle_not_found', snapshot: readSnapshot() };
          }
          const target = Boolean(payload.enabled);
          if (managedToggle.checked !== target) {
            managedToggle.click();
          }
          return { ok: true, snapshot: readSnapshot() };
        }

        if (action === 'setProtocol') {
          const protocolSelect = findLabelInput('protocol');
          if (!protocolSelect) {
            return { ok: false, error: 'protocol_select_not_found', snapshot: readSnapshot() };
          }
          const value = String(payload.protocol || '').trim().toLowerCase() === 'midi' ? 'midi' : 'osc';
          setInputLikeValue(protocolSelect, value);
          return { ok: true, snapshot: readSnapshot() };
        }

        if (action === 'setStartupAutoTransport') {
          const toggle = findStartupTransportToggle();
          if (!toggle) {
            return { ok: false, error: 'startup_auto_transport_toggle_not_found', snapshot: readSnapshot() };
          }
          const target = Boolean(payload.enabled);
          if (toggle.checked !== target) {
            toggle.click();
          }
          return { ok: true, snapshot: readSnapshot() };
        }

        if (action === 'setOscTarget') {
          const hostInput = findLabelInput('osc target ip');
          const portInput = findLabelInput('osc target port');
          const applyButton = byText(
            Array.from(document.querySelectorAll('section.output-panel button')),
            (text) => text.toLowerCase() === 'apply osc settings',
          );

          if (!hostInput || !portInput || !applyButton) {
            return { ok: false, error: 'osc_controls_not_found', snapshot: readSnapshot() };
          }

          if (!hostInput.disabled && typeof payload.host === 'string') {
            hostInput.focus();
            setInputLikeValue(hostInput, payload.host);
          }

          if (!portInput.disabled && payload.port != null) {
            portInput.focus();
            setInputLikeValue(portInput, payload.port);
          }

          if (!applyButton.disabled) {
            applyButton.click();
          }

          return { ok: true, snapshot: readSnapshot() };
        }

        if (action === 'clickEngine') {
          const command = typeof payload.command === 'string' ? payload.command.toLowerCase() : '';
          const button = findEngineButton(command);
          if (!button) {
            return { ok: false, error: 'engine_button_not_found', command, snapshot: readSnapshot() };
          }
          if (button.disabled) {
            return { ok: false, error: 'engine_button_disabled', command, snapshot: readSnapshot() };
          }
          button.click();
          return { ok: true, command, snapshot: readSnapshot() };
        }

        if (action === 'clickTransport') {
          const state = typeof payload.state === 'string' ? payload.state.toLowerCase() : 'on';
          const button = findAudioTransportButton(state);
          if (!button) {
            return { ok: false, error: 'audio_transport_button_not_found', state, snapshot: readSnapshot() };
          }
          if (button.disabled) {
            return { ok: false, error: 'audio_transport_button_disabled', state, snapshot: readSnapshot() };
          }
          button.click();
          return { ok: true, state, snapshot: readSnapshot() };
        }

        if (action === 'setRecordFileName') {
          const input = findAudioLabelInput('record file name');
          const panel = getAudioPanel();
          const applyButton = panel
            ? byText(Array.from(panel.querySelectorAll('button')), (text) => text.toLowerCase() === 'apply file name')
            : null;
          if (!input || !applyButton) {
            return { ok: false, error: 'record_file_name_controls_not_found', snapshot: readSnapshot() };
          }

          setInputLikeValue(input, String(payload.fileName || ''));
          if (!applyButton.disabled) {
            applyButton.click();
          }
          return { ok: true, snapshot: readSnapshot() };
        }

        if (action === 'setOutputFolder') {
          const input = findAudioLabelInput('output folder');
          const panel = getAudioPanel();
          const applyButton = panel
            ? byText(
                Array.from(panel.querySelectorAll('button')),
                (text) => text.toLowerCase() === 'apply output folder',
              )
            : null;
          if (!input || !applyButton) {
            return { ok: false, error: 'output_folder_controls_not_found', snapshot: readSnapshot() };
          }

          setInputLikeValue(input, String(payload.outputFolder || ''));
          if (!applyButton.disabled) {
            applyButton.click();
          }
          return { ok: true, snapshot: readSnapshot() };
        }

        if (action === 'clickRecord') {
          const state = typeof payload.state === 'string' ? payload.state.toLowerCase() : 'start';
          const button = findAudioRecordButton(state);
          if (!button) {
            return { ok: false, error: 'audio_record_button_not_found', state, snapshot: readSnapshot() };
          }
          if (button.disabled) {
            return { ok: false, error: 'audio_record_button_disabled', state, snapshot: readSnapshot() };
          }
          button.click();
          return { ok: true, state, snapshot: readSnapshot() };
        }

        if (action === 'engineStatus') {
          const api = window.granuPose?.engine;
          if (!api || typeof api.getStatus !== 'function') {
            return { ok: false, error: 'engine_api_unavailable' };
          }
          return api.getStatus();
        }

        if (action === 'engineLogs') {
          const api = window.granuPose?.engine;
          if (!api || typeof api.getLogs !== 'function') {
            return { ok: false, error: 'engine_api_unavailable' };
          }
          const limit = Number(payload.limit);
          return api.getLogs({
            limit: Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 200,
          });
        }

        return { ok: false, error: 'unknown_action' };
      })();
    `,
    true,
  );
}

async function waitForRendererReady(window) {
  const deadlineMs = Date.now() + STEP1_VALIDATION_TIMEOUT_MS;
  let lastProbe = null;

  while (Date.now() < deadlineMs) {
    lastProbe = await runRendererValidationAction(window, 'ready');
    if (lastProbe?.ready) {
      return lastProbe.snapshot;
    }
    await sleep(STEP1_VALIDATION_POLL_INTERVAL_MS);
  }

  throw new Error(
    `renderer_ready_timeout: ${JSON.stringify(lastProbe)}`,
  );
}

async function waitForSnapshot(window, description, predicate, timeoutMs = STEP1_VALIDATION_TIMEOUT_MS) {
  const deadlineMs = Date.now() + timeoutMs;
  let lastSnapshot = null;

  while (Date.now() < deadlineMs) {
    lastSnapshot = await runRendererValidationAction(window, 'snapshot');
    if (predicate(lastSnapshot)) {
      return lastSnapshot;
    }
    await sleep(STEP1_VALIDATION_POLL_INTERVAL_MS);
  }

  throw new Error(
    `snapshot_wait_timeout(${description}): ${JSON.stringify(lastSnapshot)}`,
  );
}

async function waitForEngineStatus(window, expectedStatus, timeoutMs = STEP1_VALIDATION_TIMEOUT_MS) {
  const deadlineMs = Date.now() + timeoutMs;
  let lastStatus = null;

  while (Date.now() < deadlineMs) {
    lastStatus = await runRendererValidationAction(window, 'engineStatus');
    if (lastStatus?.status === expectedStatus) {
      return lastStatus;
    }
    await sleep(STEP1_VALIDATION_POLL_INTERVAL_MS);
  }

  throw new Error(
    `engine_status_timeout(${expectedStatus}): ${JSON.stringify(lastStatus)}`,
  );
}

async function waitForEngineStatusCondition(
  window,
  description,
  predicate,
  timeoutMs = STEP1_VALIDATION_TIMEOUT_MS,
) {
  const deadlineMs = Date.now() + timeoutMs;
  let lastStatus = null;
  let lastSnapshot = null;

  while (Date.now() < deadlineMs) {
    lastStatus = await runRendererValidationAction(window, 'engineStatus');
    lastSnapshot = await runRendererValidationAction(window, 'snapshot');
    if (predicate(lastStatus, lastSnapshot)) {
      return {
        observedAtMs: Date.now(),
        status: lastStatus,
        snapshot: lastSnapshot,
      };
    }
    await sleep(STEP1_VALIDATION_POLL_INTERVAL_MS);
  }

  throw new Error(
    `engine_status_condition_timeout(${description}): ${JSON.stringify({
      lastStatus,
      lastSnapshot,
    })}`,
  );
}

function killEngineProcessForValidation(reason = 'validation_forced_kill') {
  if (!engineState.child || !engineState.pid) {
    return {
      ok: false,
      reason,
      error: 'engine_not_running',
      pid: engineState.pid ?? null,
    };
  }

  const targetPid = engineState.pid;
  const child = engineState.child;
  appendEngineLog(
    'system',
    `Validation forcing unexpected engine exit (reason=${reason}, pid=${targetPid})`,
  );

  let signaled = false;
  try {
    signaled = child.kill('SIGKILL');
  } catch {
    signaled = false;
  }

  if (!signaled) {
    try {
      signaled = child.kill();
    } catch {
      signaled = false;
    }
  }

  if (!signaled) {
    return {
      ok: false,
      reason,
      error: 'failed_to_signal_engine_process',
      pid: targetPid,
    };
  }

  return {
    ok: true,
    reason,
    signal: 'SIGKILL',
    pid: targetPid,
    atMs: Date.now(),
  };
}

async function runStep1EngineCommand(window, command, expectedStatus) {
  const startedAt = nowIso();
  let clickResult = null;
  let statusAfter = null;
  let snapshotAfter = null;

  try {
    clickResult = await runRendererValidationAction(window, 'clickEngine', { command });
    if (!clickResult?.ok) {
      return {
        command,
        expectedStatus,
        ok: false,
        startedAt,
        completedAt: nowIso(),
        clickResult,
        error: clickResult?.error || 'failed_to_trigger_engine_button',
      };
    }

    statusAfter = await waitForEngineStatus(window, expectedStatus);
    snapshotAfter = await waitForSnapshot(
      window,
      `ui_status_${expectedStatus}`,
      (snapshot) =>
        typeof snapshot?.engineStatusText === 'string' &&
        snapshot.engineStatusText.toLowerCase().includes(`engine ${expectedStatus}`),
    );

    return {
      command,
      expectedStatus,
      ok: true,
      startedAt,
      completedAt: nowIso(),
      statusAfter,
      snapshotAfter,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    snapshotAfter = await runRendererValidationAction(window, 'snapshot');
    statusAfter = await runRendererValidationAction(window, 'engineStatus');
    return {
      command,
      expectedStatus,
      ok: false,
      startedAt,
      completedAt: nowIso(),
      clickResult,
      statusAfter,
      snapshotAfter,
      error: errorMessage,
    };
  }
}

async function runStep1Validation(window) {
  const report = {
    validation: 'step1',
    checklistItems: ['A3', 'B3'],
    startedAt: nowIso(),
    settings: {
      autoStart: ENGINE_DEFAULTS.autoStart,
      autoStartAudio: ENGINE_DEFAULTS.autoStartAudio,
      noAudio: ENGINE_DEFAULTS.noAudio,
      timeoutMs: STEP1_VALIDATION_TIMEOUT_MS,
      pollIntervalMs: STEP1_VALIDATION_POLL_INTERVAL_MS,
    },
    b3: {
      ok: false,
      initialSnapshot: null,
      remoteSnapshot: null,
      relockedSnapshot: null,
      checks: {},
      errors: [],
    },
    a3: {
      ok: false,
      sequence: [],
      commandResults: [],
      logsTail: [],
      finalStatus: null,
      errors: [],
    },
    pass: false,
    completedAt: null,
  };

  const errors = [];

  try {
    await waitForRendererReady(window);
    report.b3.initialSnapshot = await runRendererValidationAction(window, 'snapshot');

    const switchRemote = await runRendererValidationAction(window, 'setManaged', { enabled: false });
    if (!switchRemote?.ok) {
      throw new Error(`failed_to_disable_managed_mode: ${switchRemote?.error || 'unknown'}`);
    }

    const remoteUnlocked = await waitForSnapshot(
      window,
      'managed_mode_off_unlock',
      (snapshot) =>
        snapshot?.managedChecked === false &&
        snapshot?.hostDisabled === false &&
        snapshot?.portDisabled === false &&
        typeof snapshot?.modeNote === 'string' &&
        snapshot.modeNote.toLowerCase().includes('remote mode active'),
    );

    const setRemote = await runRendererValidationAction(window, 'setOscTarget', {
      host: '192.168.0.99',
      port: 17777,
    });
    if (!setRemote?.ok) {
      throw new Error(`failed_to_set_remote_target: ${setRemote?.error || 'unknown'}`);
    }

    report.b3.remoteSnapshot = await waitForSnapshot(
      window,
      'remote_target_applied',
      (snapshot) =>
        snapshot?.managedChecked === false &&
        String(snapshot?.hostValue || '') === '192.168.0.99' &&
        String(snapshot?.portValue || '') === '17777',
    );

    const switchManaged = await runRendererValidationAction(window, 'setManaged', { enabled: true });
    if (!switchManaged?.ok) {
      throw new Error(`failed_to_enable_managed_mode: ${switchManaged?.error || 'unknown'}`);
    }

    report.b3.relockedSnapshot = await waitForSnapshot(
      window,
      'managed_mode_relock',
      (snapshot) =>
        snapshot?.managedChecked === true &&
        String(snapshot?.hostValue || '') === '127.0.0.1' &&
        String(snapshot?.portValue || '') === '16447' &&
        snapshot?.hostDisabled === true &&
        snapshot?.portDisabled === true &&
        typeof snapshot?.modeNote === 'string' &&
        snapshot.modeNote.toLowerCase().includes('managed mode lock active'),
    );

    report.b3.checks = {
      remoteModeUnlocked: Boolean(
        remoteUnlocked &&
          remoteUnlocked.managedChecked === false &&
          remoteUnlocked.hostDisabled === false &&
          remoteUnlocked.portDisabled === false,
      ),
      remoteTargetEditableAndApplied:
        String(report.b3.remoteSnapshot?.hostValue || '') === '192.168.0.99' &&
        String(report.b3.remoteSnapshot?.portValue || '') === '17777',
      managedModeRelocked:
        report.b3.relockedSnapshot?.managedChecked === true &&
        String(report.b3.relockedSnapshot?.hostValue || '') === '127.0.0.1' &&
        String(report.b3.relockedSnapshot?.portValue || '') === '16447' &&
        report.b3.relockedSnapshot?.hostDisabled === true &&
        report.b3.relockedSnapshot?.portDisabled === true,
      statusIndicatorPresent:
        typeof report.b3.relockedSnapshot?.bridgeMode === 'string' &&
        report.b3.relockedSnapshot.bridgeMode.toLowerCase().includes('standalone local'),
    };

    report.b3.ok = Object.values(report.b3.checks).every(Boolean);
    if (!report.b3.ok) {
      report.b3.errors.push('one_or_more_b3_checks_failed');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.b3.errors.push(message);
    errors.push(`B3: ${message}`);
  }

  report.a3.sequence = [
    { command: 'start', expectedStatus: 'running' },
    { command: 'stop', expectedStatus: 'stopped' },
    { command: 'restart', expectedStatus: 'running' },
    { command: 'stop', expectedStatus: 'stopped' },
    { command: 'start', expectedStatus: 'running' },
    { command: 'restart', expectedStatus: 'running' },
  ];

  for (const step of report.a3.sequence) {
    const result = await runStep1EngineCommand(window, step.command, step.expectedStatus);
    report.a3.commandResults.push(result);
    if (!result.ok) {
      report.a3.errors.push(`${step.command}->${step.expectedStatus}: ${result.error || 'unknown'}`);
      break;
    }
  }

  if (report.a3.commandResults.every((result) => result.ok)) {
    const cleanupStop = await runStep1EngineCommand(window, 'stop', 'stopped');
    report.a3.cleanupStop = cleanupStop;
    if (!cleanupStop.ok) {
      report.a3.errors.push(`cleanup_stop_failed: ${cleanupStop.error || 'unknown'}`);
    }
  }

  const engineLogs = await runRendererValidationAction(window, 'engineLogs', {
    limit: ENGINE_LOG_BUFFER_LIMIT,
  });
  const entries = Array.isArray(engineLogs?.entries) ? engineLogs.entries : [];
  report.a3.logsTail = entries.slice(-60);
  report.a3.finalStatus = await runRendererValidationAction(window, 'engineStatus');

  const startCount = report.a3.commandResults.filter((result) => result.command === 'start' && result.ok).length;
  const stopCount = report.a3.commandResults.filter((result) => result.command === 'stop' && result.ok).length;
  const restartCount = report.a3.commandResults.filter(
    (result) => result.command === 'restart' && result.ok,
  ).length;

  const logLines = report.a3.logsTail
    .map((entry) => (typeof entry?.line === 'string' ? entry.line : ''))
    .filter((line) => line.length > 0);

  const hasStartLog = logLines.some((line) => line.toLowerCase().includes('engine started'));
  const hasStopLog = logLines.some((line) => line.toLowerCase().includes('stopping engine'));
  const hasExitLog = logLines.some((line) => line.toLowerCase().includes('engine exited'));

  report.a3.checks = {
    startCountAtLeast2: startCount >= 2,
    stopCountAtLeast2: stopCount >= 2,
    restartCountAtLeast2: restartCount >= 2,
    noCommandFailures: report.a3.commandResults.every((result) => result.ok),
    mainProcessLogsObserved: hasStartLog && hasStopLog && hasExitLog,
    rendererAlive:
      typeof report.a3.finalStatus?.status === 'string' &&
      ['stopped', 'running', 'starting', 'stopping', 'error'].includes(report.a3.finalStatus.status),
  };

  report.a3.ok = Object.values(report.a3.checks).every(Boolean) && report.a3.errors.length === 0;
  if (!report.a3.ok && report.a3.errors.length === 0) {
    report.a3.errors.push('one_or_more_a3_checks_failed');
  }

  if (errors.length > 0) {
    report.errors = errors;
  }

  report.pass = report.a3.ok && report.b3.ok;
  report.completedAt = nowIso();
  return report;
}

async function ensureEngineStoppedForValidation(window) {
  const status = await runRendererValidationAction(window, 'engineStatus');
  if (!status || !['running', 'starting', 'stopping', 'error'].includes(status.status)) {
    return status;
  }

  const stopResult = await runStep1EngineCommand(window, 'stop', 'stopped');
  if (!stopResult.ok) {
    throw new Error(`failed_to_stop_engine_for_validation: ${stopResult.error || 'unknown'}`);
  }
  return stopResult.statusAfter;
}

function parseStartupTransportValue(helloArgsMap) {
  const raw = helloArgsMap && Object.prototype.hasOwnProperty.call(helloArgsMap, 'startupTransport')
    ? helloArgsMap.startupTransport
    : null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function extractLogLines(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => (typeof entry?.line === 'string' ? entry.line : ''))
    .filter((line) => line.length > 0);
}

async function ensureFreshDirectory(directoryPath) {
  await fs.rm(directoryPath, { recursive: true, force: true });
  await fs.mkdir(directoryPath, { recursive: true });
}

async function listRecordFiles(directoryPath) {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.resolve(directoryPath, entry.name);
      try {
        const stats = await fs.stat(filePath);
        files.push({
          name: entry.name,
          path: filePath,
          sizeBytes: Number(stats.size) || 0,
          mtimeMs: Number(stats.mtimeMs) || 0,
        });
      } catch {
        // Ignore files that cannot be stat'ed.
      }
    }

    files.sort((a, b) => a.name.localeCompare(b.name));
    return files;
  } catch {
    return [];
  }
}

function diffNewRecordFiles(beforeFiles, afterFiles) {
  const beforeSet = new Set(
    (Array.isArray(beforeFiles) ? beforeFiles : []).map((entry) =>
      String(entry?.path || '').toLowerCase(),
    ),
  );

  return (Array.isArray(afterFiles) ? afterFiles : []).filter((entry) => {
    const key = String(entry?.path || '').toLowerCase();
    return key.length > 0 && !beforeSet.has(key);
  });
}

function buildCollisionName(baseFileName, suffixIndex) {
  const normalized = typeof baseFileName === 'string' && baseFileName.trim().length > 0
    ? baseFileName.trim()
    : 'take.wav';
  const extension = path.extname(normalized) || '.wav';
  const stem = path.basename(normalized, extension) || 'take';
  return suffixIndex <= 0 ? `${stem}${extension}` : `${stem}_${suffixIndex}${extension}`;
}

async function runStep2Validation(window) {
  const report = {
    validation: 'step2',
    checklistItems: ['C1', 'C2', 'C3'],
    startedAt: nowIso(),
    settings: {
      autoStart: ENGINE_DEFAULTS.autoStart,
      autoStartAudio: ENGINE_DEFAULTS.autoStartAudio,
      noAudio: ENGINE_DEFAULTS.noAudio,
      timeoutMs: STEP1_VALIDATION_TIMEOUT_MS,
      pollIntervalMs: STEP1_VALIDATION_POLL_INTERVAL_MS,
    },
    preflight: {},
    c1: {
      ok: false,
      checks: {},
      startResult: null,
      hello: null,
      baselineWindow: null,
      transportOnAction: null,
      transportOnWindow: null,
      errors: [],
    },
    c2: {
      ok: false,
      checks: {},
      stopCycles: [],
      engineStatusAfterStops: null,
      logsTail: [],
      errors: [],
    },
    c3: {
      ok: false,
      checks: {},
      scenarios: {
        baseline: null,
        autostartAudio: null,
        noAudioOverride: null,
      },
      errors: [],
    },
    pass: false,
    completedAt: null,
  };

  const originalFlags = {
    autoStartAudio: ENGINE_DEFAULTS.autoStartAudio,
    noAudio: ENGINE_DEFAULTS.noAudio,
  };

  const sectionErrors = [];
  const movementThreshold = 0.005;
  const stableThreshold = 0.003;

  const runFlagScenario = async (scenarioName, flags, options = {}) => {
    ENGINE_DEFAULTS.autoStartAudio = Boolean(flags.autoStartAudio);
    ENGINE_DEFAULTS.noAudio = Boolean(flags.noAudio);

    await ensureEngineStoppedForValidation(window);
    clearTelemetryScans();
    const logStartIndex = engineState.logBuffer.length;
    const startedAtMs = Date.now();

    const startResult = await runStep1EngineCommand(window, 'start', 'running');
    if (!startResult.ok) {
      throw new Error(`${scenarioName}:engine_start_failed:${startResult.error || 'unknown'}`);
    }

    const helloResult = await waitForTelemetryHello(startedAtMs);
    const startupWindow = await captureTelemetryScanWindow(1800, {
      minCount: 8,
      timeoutMs: 10000,
    });

    let transportOnAction = null;
    let postTransportWindow = null;
    if (options.clickTransportOn) {
      transportOnAction = await runRendererValidationAction(window, 'clickTransport', { state: 'on' });
      if (!transportOnAction?.ok) {
        throw new Error(`${scenarioName}:transport_on_failed:${transportOnAction?.error || 'unknown'}`);
      }

      postTransportWindow = await captureTelemetryScanWindow(1800, {
        minCount: 8,
        timeoutMs: 10000,
      });
    }

    const logs = engineState.logBuffer.slice(logStartIndex);

    const stopResult = await runStep1EngineCommand(window, 'stop', 'stopped');
    if (!stopResult.ok) {
      throw new Error(`${scenarioName}:engine_stop_failed:${stopResult.error || 'unknown'}`);
    }

    return {
      scenarioName,
      flags: {
        autoStartAudio: ENGINE_DEFAULTS.autoStartAudio,
        noAudio: ENGINE_DEFAULTS.noAudio,
      },
      startResult,
      hello: helloResult.hello,
      helloArgsMap: helloResult.argsMap,
      startupWindow,
      transportOnAction,
      postTransportWindow,
      logs,
      stopResult,
    };
  };

  try {
    await waitForRendererReady(window);

    const setProtocol = await runRendererValidationAction(window, 'setProtocol', { protocol: 'osc' });
    const setManaged = await runRendererValidationAction(window, 'setManaged', { enabled: true });
    const setStartupAutoTransport = await runRendererValidationAction(window, 'setStartupAutoTransport', {
      enabled: false,
    });

    report.preflight = {
      setProtocol,
      setManaged,
      setStartupAutoTransport,
    };

    if (!setProtocol?.ok || !setManaged?.ok || !setStartupAutoTransport?.ok) {
      throw new Error(
        `step2_preflight_failed:${JSON.stringify({
          setProtocolOk: Boolean(setProtocol?.ok),
          setManagedOk: Boolean(setManaged?.ok),
          setStartupAutoTransportOk: Boolean(setStartupAutoTransport?.ok),
        })}`,
      );
    }

    const stabilizedSnapshot = await waitForSnapshot(
      window,
      'step2_preflight_stabilized',
      (snapshot) =>
        snapshot?.protocolValue === 'osc' &&
        snapshot?.managedChecked === true &&
        snapshot?.startupAutoTransportChecked === false &&
        typeof snapshot?.startupPolicyNote === 'string' &&
        snapshot.startupPolicyNote.toLowerCase().includes('disabled'),
    );

    report.preflight.snapshot = stabilizedSnapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sectionErrors.push(`preflight:${message}`);
  }

  // C1 + C2 scenario (audio enabled; startup transport disabled; manual transport control)
  try {
    ENGINE_DEFAULTS.autoStartAudio = false;
    ENGINE_DEFAULTS.noAudio = false;

    await ensureEngineStoppedForValidation(window);
    clearTelemetryScans();
    const logStartIndex = engineState.logBuffer.length;
    const engineStartIssuedAtMs = Date.now();

    const startResult = await runStep1EngineCommand(window, 'start', 'running');
    report.c1.startResult = startResult;
    if (!startResult.ok) {
      throw new Error(`c1_engine_start_failed:${startResult.error || 'unknown'}`);
    }

    const helloResult = await waitForTelemetryHello(engineStartIssuedAtMs);
    report.c1.hello = helloResult.hello;

    report.c1.baselineWindow = await captureTelemetryScanWindow(1500, {
      minCount: 8,
      timeoutMs: 9000,
    });

    const transportOnAction = await runRendererValidationAction(window, 'clickTransport', { state: 'on' });
    report.c1.transportOnAction = transportOnAction;
    if (!transportOnAction?.ok) {
      throw new Error(`c1_transport_on_failed:${transportOnAction?.error || 'unknown'}`);
    }

    report.c1.transportOnWindow = await captureTelemetryScanWindow(2000, {
      minCount: 10,
      timeoutMs: 10000,
    });

    const startupTransportValue = parseStartupTransportValue(helloResult.argsMap);
    const transportOnMovementDetected =
      report.c1.transportOnWindow.stats.playheadSpan > movementThreshold ||
      report.c1.transportOnWindow.stats.scanHeadSpan > movementThreshold;
    const c1LogLines = extractLogLines(engineState.logBuffer.slice(logStartIndex));

    report.c1.checks = {
      engineStartSucceeded: Boolean(startResult.ok),
      startupTransportIsZeroInManualMode: startupTransportValue === 0,
      telemetryCadencePresent: report.c1.transportOnWindow.stats.count >= 10,
      transportOnMovementDetected,
      transportOneLogObserved: c1LogLines.some((line) => line.toLowerCase().includes('transport 1')),
    };

    report.c1.ok = Object.values(report.c1.checks).every(Boolean);
    if (!report.c1.ok) {
      report.c1.errors.push('one_or_more_c1_checks_failed');
    }

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const stopAction = await runRendererValidationAction(window, 'clickTransport', { state: 'off' });
      const stopWindow = await captureTelemetryScanWindow(1500, {
        minCount: 8,
        timeoutMs: 10000,
      });
      report.c2.stopCycles.push({
        cycle,
        stopAction,
        stopWindow,
      });
    }

    report.c2.engineStatusAfterStops = await runRendererValidationAction(window, 'engineStatus');
    const newLogs = engineState.logBuffer.slice(logStartIndex);
    report.c2.logsTail = newLogs.slice(-120);

    const stopStableAllCycles = report.c2.stopCycles.every(
      (entry) =>
        entry?.stopAction?.ok &&
        entry.stopWindow?.stats?.playheadSpan <= stableThreshold &&
        entry.stopWindow?.stats?.scanHeadSpan <= stableThreshold,
    );
    const c2LogLines = extractLogLines(report.c2.logsTail);

    report.c2.checks = {
      stopCyclesAtLeast3: report.c2.stopCycles.length >= 3,
      allStopActionsSucceeded: report.c2.stopCycles.every((entry) => Boolean(entry?.stopAction?.ok)),
      stopTelemetryStableAfterEachCycle: stopStableAllCycles,
      engineStillRunningAfterStopCycles: report.c2.engineStatusAfterStops?.status === 'running',
      transportZeroLogsObserved: c2LogLines.some((line) => line.toLowerCase().includes('transport 0')),
      noUnexpectedExitLog: !c2LogLines.some((line) => line.toLowerCase().includes('unexpectedly')),
    };

    report.c2.ok = Object.values(report.c2.checks).every(Boolean);
    if (!report.c2.ok) {
      report.c2.errors.push('one_or_more_c2_checks_failed');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.c1.errors.push(message);
    report.c2.errors.push(message);
    sectionErrors.push(`c1_c2:${message}`);
  } finally {
    try {
      await ensureEngineStoppedForValidation(window);
    } catch {
      // best effort cleanup
    }
  }

  // C3 scenarios
  try {
    report.c3.scenarios.baseline = await runFlagScenario(
      'c3_baseline',
      { autoStartAudio: false, noAudio: false },
      { clickTransportOn: false },
    );

    report.c3.scenarios.autostartAudio = await runFlagScenario(
      'c3_autostart_audio',
      { autoStartAudio: true, noAudio: false },
      { clickTransportOn: false },
    );

    report.c3.scenarios.noAudioOverride = await runFlagScenario(
      'c3_no_audio_override',
      { autoStartAudio: true, noAudio: true },
      { clickTransportOn: true },
    );

    const baselineTransport = parseStartupTransportValue(
      report.c3.scenarios.baseline.helloArgsMap,
    );
    const autostartTransport = parseStartupTransportValue(
      report.c3.scenarios.autostartAudio.helloArgsMap,
    );
    const noAudioTransport = parseStartupTransportValue(
      report.c3.scenarios.noAudioOverride.helloArgsMap,
    );
    const noAudioLogLines = extractLogLines(report.c3.scenarios.noAudioOverride.logs);

    report.c3.checks = {
      baselineStartupTransportZero: baselineTransport === 0,
      autostartStartupTransportOne: autostartTransport === 1,
      autostartTelemetryMoves:
        report.c3.scenarios.autostartAudio.startupWindow.stats.playheadSpan > movementThreshold ||
        report.c3.scenarios.autostartAudio.startupWindow.stats.scanHeadSpan > movementThreshold,
      noAudioOverridesStartupTransport: noAudioTransport === 0,
      noAudioTransportCommandIgnoredLogPresent: noAudioLogLines.some((line) =>
        line.toLowerCase().includes('ignored /transport 1 because --no-audio is active'),
      ),
      noAudioTransportRemainsStableAfterTransportOn:
        (report.c3.scenarios.noAudioOverride.postTransportWindow?.stats?.playheadSpan || 0) <= stableThreshold &&
        (report.c3.scenarios.noAudioOverride.postTransportWindow?.stats?.scanHeadSpan || 0) <= stableThreshold,
    };

    report.c3.ok = Object.values(report.c3.checks).every(Boolean);
    if (!report.c3.ok) {
      report.c3.errors.push('one_or_more_c3_checks_failed');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.c3.errors.push(message);
    sectionErrors.push(`c3:${message}`);
  } finally {
    ENGINE_DEFAULTS.autoStartAudio = originalFlags.autoStartAudio;
    ENGINE_DEFAULTS.noAudio = originalFlags.noAudio;
    try {
      await ensureEngineStoppedForValidation(window);
    } catch {
      // best effort cleanup
    }
  }

  if (sectionErrors.length > 0) {
    report.errors = sectionErrors;
  }

  report.pass = report.c1.ok && report.c2.ok && report.c3.ok;
  report.completedAt = nowIso();
  return report;
}

async function runStep3Validation(window) {
  const d1RecordMs = parseBoundedInt(process.env.GRANUPOSE_STEP3_D1_RECORD_MS, 10000, 2000, 120000);
  const d2CycleRecordMs = parseBoundedInt(process.env.GRANUPOSE_STEP3_D2_RECORD_MS, 3000, 1000, 120000);
  const cycleCount = 3;
  const settleAfterStopMs = 450;
  const requestedFileName = 'take.wav';
  const outputDir = path.resolve(app.getPath('temp'), `granuPose-step3-validation-${Date.now()}`);

  const report = {
    validation: 'step3',
    checklistItems: ['D1', 'D2'],
    startedAt: nowIso(),
    settings: {
      autoStart: ENGINE_DEFAULTS.autoStart,
      autoStartAudio: ENGINE_DEFAULTS.autoStartAudio,
      noAudio: ENGINE_DEFAULTS.noAudio,
      timeoutMs: STEP1_VALIDATION_TIMEOUT_MS,
      pollIntervalMs: STEP1_VALIDATION_POLL_INTERVAL_MS,
      d1RecordMs,
      d2CycleRecordMs,
      cycleCount,
      settleAfterStopMs,
      requestedFileName,
    },
    preflight: {
      outputDir,
    },
    d1: {
      ok: false,
      cycle: null,
      checks: {},
      engineStatusAfterCycle: null,
      logsTail: [],
      errors: [],
    },
    d2: {
      ok: false,
      cycles: [],
      filesAfterAllCycles: [],
      checks: {},
      engineStatusAfterCycles: null,
      logsTail: [],
      errors: [],
    },
    pass: false,
    completedAt: null,
  };

  const originalFlags = {
    autoStartAudio: ENGINE_DEFAULTS.autoStartAudio,
    noAudio: ENGINE_DEFAULTS.noAudio,
  };
  const sectionErrors = [];

  const normalizePathForCompare = (value) =>
    String(value || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/g, '')
      .toLowerCase();

  const runRecordCycle = async (label, durationMs) => {
    const filesBefore = await listRecordFiles(outputDir);
    const logStartIndex = engineState.logBuffer.length;
    const startedAtMs = Date.now();

    const startAction = await runRendererValidationAction(window, 'clickRecord', { state: 'start' });
    if (startAction?.ok) {
      await sleep(durationMs);
    } else {
      await sleep(200);
    }

    const stopAction = await runRendererValidationAction(window, 'clickRecord', { state: 'stop' });
    await sleep(settleAfterStopMs);

    const filesAfter = await listRecordFiles(outputDir);
    const createdFiles = diffNewRecordFiles(filesBefore, filesAfter);
    const logs = engineState.logBuffer.slice(logStartIndex);
    const logLines = extractLogLines(logs);

    return {
      label,
      durationMs,
      startedAtMs,
      completedAtMs: Date.now(),
      startAction,
      stopAction,
      filesBefore,
      filesAfter,
      createdFiles,
      createdFileCount: createdFiles.length,
      createdFilesNonZero: createdFiles.every((entry) => Number(entry?.sizeBytes) > 0),
      logs,
      recordStartLogObserved: logLines.some((line) => line.toLowerCase().includes('record 1 path')),
      recordStopLogObserved: logLines.some((line) => line.toLowerCase().includes('record 0 path')),
    };
  };

  try {
    await waitForRendererReady(window);

    const setProtocol = await runRendererValidationAction(window, 'setProtocol', { protocol: 'osc' });
    const setManaged = await runRendererValidationAction(window, 'setManaged', { enabled: true });
    const setStartupAutoTransport = await runRendererValidationAction(window, 'setStartupAutoTransport', {
      enabled: false,
    });

    report.preflight.setProtocol = setProtocol;
    report.preflight.setManaged = setManaged;
    report.preflight.setStartupAutoTransport = setStartupAutoTransport;

    if (!setProtocol?.ok || !setManaged?.ok || !setStartupAutoTransport?.ok) {
      throw new Error(
        `step3_preflight_controls_failed:${JSON.stringify({
          setProtocolOk: Boolean(setProtocol?.ok),
          setManagedOk: Boolean(setManaged?.ok),
          setStartupAutoTransportOk: Boolean(setStartupAutoTransport?.ok),
        })}`,
      );
    }

    const stabilizedSnapshot = await waitForSnapshot(
      window,
      'step3_preflight_stabilized',
      (snapshot) =>
        snapshot?.protocolValue === 'osc' &&
        snapshot?.managedChecked === true &&
        snapshot?.startupAutoTransportChecked === false,
    );
    report.preflight.snapshot = stabilizedSnapshot;

    await ensureEngineStoppedForValidation(window);
    ENGINE_DEFAULTS.autoStartAudio = false;
    ENGINE_DEFAULTS.noAudio = false;
    clearTelemetryScans();

    const startIssuedAtMs = Date.now();
    const startResult = await runStep1EngineCommand(window, 'start', 'running');
    report.preflight.startResult = startResult;
    if (!startResult.ok) {
      throw new Error(`step3_engine_start_failed:${startResult.error || 'unknown'}`);
    }

    const helloResult = await waitForTelemetryHello(startIssuedAtMs);
    report.preflight.hello = helloResult.hello;

    const transportOnAction = await runRendererValidationAction(window, 'clickTransport', { state: 'on' });
    report.preflight.transportOnAction = transportOnAction;
    if (!transportOnAction?.ok) {
      throw new Error(`step3_transport_on_failed:${transportOnAction?.error || 'unknown'}`);
    }

    await ensureFreshDirectory(outputDir);

    const setOutputFolder = await runRendererValidationAction(window, 'setOutputFolder', {
      outputFolder: outputDir,
    });
    const setRecordFileName = await runRendererValidationAction(window, 'setRecordFileName', {
      fileName: requestedFileName,
    });
    report.preflight.setOutputFolder = setOutputFolder;
    report.preflight.setRecordFileName = setRecordFileName;

    if (!setOutputFolder?.ok || !setRecordFileName?.ok) {
      throw new Error(
        `step3_record_controls_failed:${JSON.stringify({
          setOutputFolderOk: Boolean(setOutputFolder?.ok),
          setRecordFileNameOk: Boolean(setRecordFileName?.ok),
        })}`,
      );
    }

    const recordsSnapshot = await waitForSnapshot(
      window,
      'step3_record_config_applied',
      (snapshot) =>
        normalizePathForCompare(snapshot?.outputFolderValue) === normalizePathForCompare(outputDir) &&
        String(snapshot?.recordFileNameValue || '').trim().toLowerCase() === requestedFileName,
    );
    report.preflight.recordSnapshot = recordsSnapshot;

    const d1LogStartIndex = engineState.logBuffer.length;
    const d1Cycle = await runRecordCycle('d1_single_cycle', d1RecordMs);
    report.d1.cycle = d1Cycle;
    report.d1.engineStatusAfterCycle = await runRendererValidationAction(window, 'engineStatus');
    report.d1.logsTail = engineState.logBuffer.slice(d1LogStartIndex);

    const d1CreatedFile = Array.isArray(d1Cycle.createdFiles) && d1Cycle.createdFiles.length > 0
      ? d1Cycle.createdFiles[0]
      : null;
    report.d1.checks = {
      recordStartActionSucceeded: Boolean(d1Cycle.startAction?.ok),
      recordStopActionSucceeded: Boolean(d1Cycle.stopAction?.ok),
      createdFileObserved: Boolean(d1CreatedFile),
      createdFileNonZeroBytes: Boolean(d1CreatedFile && Number(d1CreatedFile.sizeBytes) > 0),
      recordStartLogObserved: Boolean(d1Cycle.recordStartLogObserved),
      recordStopLogObserved: Boolean(d1Cycle.recordStopLogObserved),
      engineStillRunningAfterD1: report.d1.engineStatusAfterCycle?.status === 'running',
    };
    report.d1.ok = Object.values(report.d1.checks).every(Boolean);
    if (!report.d1.ok) {
      report.d1.errors.push('one_or_more_d1_checks_failed');
    }

    const d2LogStartIndex = engineState.logBuffer.length;
    for (let cycle = 1; cycle <= cycleCount; cycle += 1) {
      const result = await runRecordCycle(`d2_cycle_${cycle}`, d2CycleRecordMs);
      report.d2.cycles.push({
        cycle,
        ...result,
      });
    }

    report.d2.filesAfterAllCycles = await listRecordFiles(outputDir);
    report.d2.engineStatusAfterCycles = await runRendererValidationAction(window, 'engineStatus');
    report.d2.logsTail = engineState.logBuffer.slice(d2LogStartIndex);

    const d2LogLines = extractLogLines(report.d2.logsTail);
    const expectedNames = Array.from({ length: cycleCount + 1 }, (_entry, index) =>
      buildCollisionName(requestedFileName, index),
    );
    const observedNames = report.d2.filesAfterAllCycles.map((entry) => entry.name.toLowerCase());
    report.d2.checks = {
      cycleCountAtLeastThree: report.d2.cycles.length >= cycleCount,
      allRecordActionsSucceeded: report.d2.cycles.every(
        (entry) => Boolean(entry?.startAction?.ok) && Boolean(entry?.stopAction?.ok),
      ),
      filesCreatedEachCycle: report.d2.cycles.every((entry) => Number(entry?.createdFileCount) >= 1),
      everyCreatedFileNonZeroBytes: report.d2.cycles.every((entry) => Boolean(entry?.createdFilesNonZero)),
      collisionPolicyObserved: expectedNames.every((name) => observedNames.includes(name.toLowerCase())),
      engineStillRunningAfterD2: report.d2.engineStatusAfterCycles?.status === 'running',
      recordStartLogsObserved: d2LogLines.filter((line) => line.toLowerCase().includes('record 1 path')).length >= cycleCount,
      recordStopLogsObserved: d2LogLines.filter((line) => line.toLowerCase().includes('record 0 path')).length >= cycleCount,
      noUnexpectedExitLog: !d2LogLines.some((line) => line.toLowerCase().includes('unexpectedly')),
    };

    report.d2.ok = Object.values(report.d2.checks).every(Boolean);
    if (!report.d2.ok) {
      report.d2.errors.push('one_or_more_d2_checks_failed');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sectionErrors.push(message);
    report.d1.errors.push(message);
    report.d2.errors.push(message);
  } finally {
    try {
      await runRendererValidationAction(window, 'clickTransport', { state: 'off' });
    } catch {
      // best effort
    }

    ENGINE_DEFAULTS.autoStartAudio = originalFlags.autoStartAudio;
    ENGINE_DEFAULTS.noAudio = originalFlags.noAudio;

    try {
      await ensureEngineStoppedForValidation(window);
    } catch {
      // best effort cleanup
    }
  }

  if (sectionErrors.length > 0) {
    report.errors = sectionErrors;
  }

  report.pass = report.d1.ok && report.d2.ok;
  report.completedAt = nowIso();
  return report;
}

async function runStep3ValidationHarness(window) {
  if (validationHarnessInProgress) {
    return;
  }
  validationHarnessInProgress = true;

  let report = null;
  let reportPath = '';
  let exitCode = 1;

  try {
    report = await runStep3Validation(window);
    reportPath = await writeValidationReport('step3', report);
    appendEngineLog(
      'system',
      `Step3 validation ${report.pass ? 'PASS' : 'FAIL'} report=${reportPath}`,
    );
    exitCode = report.pass ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report = {
      validation: 'step3',
      startedAt: nowIso(),
      completedAt: nowIso(),
      pass: false,
      fatalError: message,
    };
    reportPath = await writeValidationReport('step3', report);
    appendEngineLog('system', `Step3 validation failed: ${message}`);
    exitCode = 1;
  } finally {
    try {
      await stopEngine('step3_validation_cleanup');
    } catch {
      // cleanup best effort
    }
    closeOscPort();
    closeTelemetryPort();
    closeMidiOutput();
    console.log(`[step3-validation] report=${reportPath} pass=${Boolean(report?.pass)}`);
    setTimeout(() => {
      app.exit(exitCode);
    }, 250);
  }
}

async function runStep1ValidationHarness(window) {
  if (validationHarnessInProgress) {
    return;
  }
  validationHarnessInProgress = true;

  let report = null;
  let reportPath = '';
  let exitCode = 1;

  try {
    report = await runStep1Validation(window);
    reportPath = await writeValidationReport('step1', report);
    appendEngineLog(
      'system',
      `Step1 validation ${report.pass ? 'PASS' : 'FAIL'} report=${reportPath}`,
    );
    exitCode = report.pass ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report = {
      validation: 'step1',
      startedAt: nowIso(),
      completedAt: nowIso(),
      pass: false,
      fatalError: message,
    };
    reportPath = await writeValidationReport('step1', report);
    appendEngineLog('system', `Step1 validation failed: ${message}`);
    exitCode = 1;
  } finally {
    try {
      await stopEngine('step1_validation_cleanup');
    } catch {
      // cleanup best effort
    }
    closeOscPort();
    closeTelemetryPort();
    closeMidiOutput();
    console.log(`[step1-validation] report=${reportPath} pass=${Boolean(report?.pass)}`);
    setTimeout(() => {
      app.exit(exitCode);
    }, 250);
  }
}

async function runStep2ValidationHarness(window) {
  if (validationHarnessInProgress) {
    return;
  }
  validationHarnessInProgress = true;

  let report = null;
  let reportPath = '';
  let exitCode = 1;

  try {
    report = await runStep2Validation(window);
    reportPath = await writeValidationReport('step2', report);
    appendEngineLog(
      'system',
      `Step2 validation ${report.pass ? 'PASS' : 'FAIL'} report=${reportPath}`,
    );
    exitCode = report.pass ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report = {
      validation: 'step2',
      startedAt: nowIso(),
      completedAt: nowIso(),
      pass: false,
      fatalError: message,
    };
    reportPath = await writeValidationReport('step2', report);
    appendEngineLog('system', `Step2 validation failed: ${message}`);
    exitCode = 1;
  } finally {
    try {
      await stopEngine('step2_validation_cleanup');
    } catch {
      // cleanup best effort
    }
    closeOscPort();
    closeTelemetryPort();
    closeMidiOutput();
    console.log(`[step2-validation] report=${reportPath} pass=${Boolean(report?.pass)}`);
    setTimeout(() => {
      app.exit(exitCode);
    }, 250);
  }
}

async function runStep4Validation(window) {
  const report = {
    validation: 'step4',
    checklistItems: ['E3'],
    startedAt: nowIso(),
    settings: {
      autoStart: ENGINE_DEFAULTS.autoStart,
      autoStartAudio: ENGINE_DEFAULTS.autoStartAudio,
      noAudio: ENGINE_DEFAULTS.noAudio,
      timeoutMs: STEP1_VALIDATION_TIMEOUT_MS,
      pollIntervalMs: STEP1_VALIDATION_POLL_INTERVAL_MS,
      watchdogAutoRestart: ENGINE_WATCHDOG_DEFAULTS.autoRestart,
      watchdogRestartBaseDelayMs: ENGINE_WATCHDOG_DEFAULTS.restartBaseDelayMs,
      watchdogRestartMaxDelayMs: ENGINE_WATCHDOG_DEFAULTS.restartMaxDelayMs,
      watchdogRestartMaxAttempts: ENGINE_WATCHDOG_DEFAULTS.restartMaxAttempts,
    },
    preflight: {},
    e3: {
      ok: false,
      checks: {},
      metrics: {},
      startResult: null,
      initialStatus: null,
      hello: null,
      killAction: null,
      errorObservation: null,
      restartObservation: null,
      logsTail: [],
      errors: [],
    },
    pass: false,
    completedAt: null,
  };

  const originalFlags = {
    autoStartAudio: ENGINE_DEFAULTS.autoStartAudio,
    noAudio: ENGINE_DEFAULTS.noAudio,
  };
  const sectionErrors = [];
  const restartObservationTimeoutMs = Math.max(
    5000,
    Math.min(
      60000,
      ENGINE_WATCHDOG_DEFAULTS.restartBaseDelayMs + ENGINE_WATCHDOG_DEFAULTS.restartMaxDelayMs + 12000,
    ),
  );

  try {
    await waitForRendererReady(window);

    const setProtocol = await runRendererValidationAction(window, 'setProtocol', { protocol: 'osc' });
    const setManaged = await runRendererValidationAction(window, 'setManaged', { enabled: true });
    report.preflight.setProtocol = setProtocol;
    report.preflight.setManaged = setManaged;

    if (!setProtocol?.ok || !setManaged?.ok) {
      throw new Error(
        `step4_preflight_controls_failed:${JSON.stringify({
          setProtocolOk: Boolean(setProtocol?.ok),
          setManagedOk: Boolean(setManaged?.ok),
        })}`,
      );
    }

    report.preflight.snapshot = await waitForSnapshot(
      window,
      'step4_preflight_stabilized',
      (snapshot) => snapshot?.protocolValue === 'osc' && snapshot?.managedChecked === true,
    );

    ENGINE_DEFAULTS.autoStartAudio = false;
    ENGINE_DEFAULTS.noAudio = false;
    await ensureEngineStoppedForValidation(window);
    clearTelemetryScans();

    const logStartIndex = engineState.logBuffer.length;
    const startIssuedAtMs = Date.now();
    const startResult = await runStep1EngineCommand(window, 'start', 'running');
    report.e3.startResult = startResult;
    if (!startResult.ok) {
      throw new Error(`step4_engine_start_failed:${startResult.error || 'unknown'}`);
    }

    report.e3.initialStatus = await runRendererValidationAction(window, 'engineStatus');
    const helloResult = await waitForTelemetryHello(startIssuedAtMs);
    report.e3.hello = helloResult.hello;

    const killAction = killEngineProcessForValidation('step4_watchdog_forced_exit');
    report.e3.killAction = killAction;
    if (!killAction?.ok) {
      throw new Error(`step4_kill_failed:${killAction?.error || 'unknown'}`);
    }

    const errorObservation = await waitForEngineStatusCondition(
      window,
      'error_after_forced_exit',
      (status) => status?.status === 'error',
      12000,
    );
    report.e3.errorObservation = errorObservation;

    const restartObservation = await waitForEngineStatusCondition(
      window,
      'running_after_watchdog_restart',
      (status) => status?.status === 'running' && Number(status?.pid) > 0,
      restartObservationTimeoutMs,
    );
    report.e3.restartObservation = restartObservation;

    const logs = engineState.logBuffer.slice(logStartIndex);
    report.e3.logsTail = logs.slice(-180);
    const logLines = extractLogLines(logs);
    const errorStatusText = String(errorObservation?.snapshot?.engineStatusText || '').toLowerCase();
    const errorFeedbackText = String(errorObservation?.snapshot?.engineFeedbackText || '').toLowerCase();
    const errorLastErrorText = String(errorObservation?.status?.lastError || '').toLowerCase();
    const killPid = Number(killAction?.pid) || null;
    const restartPid = Number(restartObservation?.status?.pid) || null;
    const restartLatencyMs =
      Number(killAction?.atMs) > 0 && Number(restartObservation?.observedAtMs) > 0
        ? Math.max(0, Number(restartObservation.observedAtMs) - Number(killAction.atMs))
        : null;

    report.e3.metrics = {
      killPid,
      restartPid,
      pidChanged: killPid != null && restartPid != null ? restartPid !== killPid : null,
      restartLatencyMs,
      restartObservationTimeoutMs,
      restartAttemptsAtRecovery: Number(restartObservation?.status?.restartAttempts) || 0,
    };

    report.e3.checks = {
      helloReceivedBeforeKill: Boolean(report.e3.hello),
      unexpectedExitLogObserved: logLines.some((line) =>
        line.toLowerCase().includes('engine exited unexpectedly'),
      ),
      restartScheduledLogObserved: logLines.some((line) =>
        line.toLowerCase().includes('scheduling engine restart attempt'),
      ),
      restartExecutionLogObserved: logLines.some((line) =>
        line.toLowerCase().includes('executing engine restart attempt'),
      ),
      watchdogTriggeredStartLogObserved: logLines.some((line) =>
        line.toLowerCase().includes('(trigger=watchdog)'),
      ),
      uiErrorStateObserved:
        errorObservation?.status?.status === 'error' &&
        (errorStatusText.includes('engine error') ||
          errorFeedbackText.includes('engine error') ||
          errorLastErrorText.includes('exited unexpectedly')),
      restartRecoveredRunning: restartObservation?.status?.status === 'running',
      restartAttemptCounterIncremented: Number(restartObservation?.status?.restartAttempts) >= 1,
      restartedPidPresent: Number(restartObservation?.status?.pid) > 0,
      restartLatencyWithinWindow:
        restartLatencyMs != null ? restartLatencyMs <= restartObservationTimeoutMs : false,
    };

    report.e3.ok = Object.values(report.e3.checks).every(Boolean);
    if (!report.e3.ok) {
      report.e3.errors.push('one_or_more_e3_checks_failed');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sectionErrors.push(message);
    report.e3.errors.push(message);
  } finally {
    ENGINE_DEFAULTS.autoStartAudio = originalFlags.autoStartAudio;
    ENGINE_DEFAULTS.noAudio = originalFlags.noAudio;

    try {
      await ensureEngineStoppedForValidation(window);
    } catch {
      // best effort cleanup
    }
  }

  if (sectionErrors.length > 0) {
    report.errors = sectionErrors;
  }

  report.pass = report.e3.ok;
  report.completedAt = nowIso();
  return report;
}

async function runStep4ValidationHarness(window) {
  if (validationHarnessInProgress) {
    return;
  }
  validationHarnessInProgress = true;

  let report = null;
  let reportPath = '';
  let exitCode = 1;

  try {
    report = await runStep4Validation(window);
    reportPath = await writeValidationReport('step4', report);
    appendEngineLog(
      'system',
      `Step4 validation ${report.pass ? 'PASS' : 'FAIL'} report=${reportPath}`,
    );
    exitCode = report.pass ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report = {
      validation: 'step4',
      startedAt: nowIso(),
      completedAt: nowIso(),
      pass: false,
      fatalError: message,
    };
    reportPath = await writeValidationReport('step4', report);
    appendEngineLog('system', `Step4 validation failed: ${message}`);
    exitCode = 1;
  } finally {
    try {
      await stopEngine('step4_validation_cleanup');
    } catch {
      // cleanup best effort
    }
    closeOscPort();
    closeTelemetryPort();
    closeMidiOutput();
    console.log(`[step4-validation] report=${reportPath} pass=${Boolean(report?.pass)}`);
    setTimeout(() => {
      app.exit(exitCode);
    }, 250);
  }
}

function getEngineBinaryName() {
  return process.platform === 'win32' ? 'ec2_headless.exe' : 'ec2_headless';
}

function resolvePathFromEnv(rawPath) {
  if (typeof rawPath !== 'string') {
    return '';
  }

  const trimmed = rawPath.trim();
  if (!trimmed) {
    return '';
  }

  return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

function getEngineBinaryCandidatePaths() {
  const binaryName = getEngineBinaryName();
  const platformDir =
    process.platform === 'win32'
      ? 'win32'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux';
  const fromEnv = resolvePathFromEnv(process.env.GRANUPOSE_ENGINE_PATH);

  const candidates = [
    fromEnv,
    path.resolve(app.getAppPath(), '..', 'engine-bin', platformDir, binaryName),
    path.resolve(app.getAppPath(), '..', 'engine-bin', binaryName),
    path.resolve(app.getAppPath(), '..', 'EmissionControl2', 'ecSource', 'bin', binaryName),
    path.resolve(__dirname, '..', '..', 'engine-bin', platformDir, binaryName),
    path.resolve(__dirname, '..', '..', 'engine-bin', binaryName),
    path.resolve(__dirname, '..', '..', 'EmissionControl2', 'ecSource', 'bin', binaryName),
    path.resolve(process.cwd(), 'engine-bin', platformDir, binaryName),
    path.resolve(process.cwd(), 'engine-bin', binaryName),
    path.resolve(process.cwd(), 'EmissionControl2', 'ecSource', 'bin', binaryName),
    path.resolve(process.resourcesPath, 'engine-bin', platformDir, binaryName),
    path.resolve(process.resourcesPath, 'engine-bin', binaryName),
    path.resolve(process.resourcesPath, 'ec2', binaryName),
  ];

  return dedupeNames(candidates);
}

function getEngineSamplesDirCandidatePaths() {
  const fromEnv = resolvePathFromEnv(process.env.GRANUPOSE_ENGINE_SAMPLES_DIR);
  const samplesRelativePath = path.join('EmissionControl2', 'externalResources', 'samples');
  const candidates = [
    fromEnv,
    path.resolve(app.getAppPath(), '..', samplesRelativePath),
    path.resolve(app.getAppPath(), '..', 'engine-resources', 'samples'),
    path.resolve(__dirname, '..', '..', samplesRelativePath),
    path.resolve(__dirname, '..', '..', 'engine-resources', 'samples'),
    path.resolve(process.cwd(), samplesRelativePath),
    path.resolve(process.cwd(), 'engine-resources', 'samples'),
    path.resolve(process.resourcesPath, samplesRelativePath),
    path.resolve(process.resourcesPath, 'ec2', 'samples'),
  ];

  return dedupeNames(candidates);
}

function getEngineLibDirCandidatePaths() {
  const fromEnv = resolvePathFromEnv(process.env.GRANUPOSE_ENGINE_LIB_DIR);
  const libsRelativePath = path.join('EmissionControl2', 'externalResources', 'libsndfile');
  const candidates = [
    fromEnv,
    path.resolve(app.getAppPath(), '..', libsRelativePath),
    path.resolve(app.getAppPath(), '..', 'engine-resources', 'libs'),
    path.resolve(__dirname, '..', '..', libsRelativePath),
    path.resolve(__dirname, '..', '..', 'engine-resources', 'libs'),
    path.resolve(process.cwd(), libsRelativePath),
    path.resolve(process.cwd(), 'engine-resources', 'libs'),
    path.resolve(process.resourcesPath, libsRelativePath),
    path.resolve(process.resourcesPath, 'ec2', 'libs'),
    path.resolve(process.resourcesPath, 'libs'),
  ];

  return dedupeNames(candidates);
}

async function resolveFirstExistingPath(paths) {
  for (const candidatePath of paths) {
    try {
      await fs.access(candidatePath);
      return candidatePath;
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

async function resolveEngineRuntimeConfig() {
  const binaryCandidates = getEngineBinaryCandidatePaths();
  const binaryPath = await resolveFirstExistingPath(binaryCandidates);
  if (!binaryPath) {
    return {
      ok: false,
      error: `ec2_headless binary not found. Checked: ${binaryCandidates.join(' | ')}`,
    };
  }

  const configuredDataDir = resolvePathFromEnv(process.env.GRANUPOSE_ENGINE_DATA_DIR);
  const dataDir = configuredDataDir || path.resolve(app.getPath('userData'), 'ec2');
  await fs.mkdir(dataDir, { recursive: true });

  const samplesDir = await resolveFirstExistingPath(getEngineSamplesDirCandidatePaths());
  const libsDir = await resolveFirstExistingPath(getEngineLibDirCandidatePaths());
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
    ENGINE_DEFAULTS.oscHost,
    '--osc-port',
    String(ENGINE_DEFAULTS.oscPort),
    '--telemetry-host',
    ENGINE_DEFAULTS.telemetryHost,
    '--telemetry-port',
    String(ENGINE_DEFAULTS.telemetryPort),
    '--data-dir',
    dataDir,
  ];

  if (samplesDir) {
    args.push('--samples-dir', samplesDir);
  } else {
    appendEngineLog('system', 'No bundled samples directory resolved; using engine defaults.');
  }

  if (ENGINE_DEFAULTS.autoStartAudio) {
    args.push('--autostart-audio');
  }

  if (ENGINE_DEFAULTS.noAudio) {
    args.push('--no-audio');
  }

  return {
    ok: true,
    binaryPath,
    args,
    env: spawnEnv,
    dataDir,
    samplesDir,
    libsDir,
  };
}

async function startEngine(options = {}) {
  const preserveWatchdogBackoff = Boolean(options.preserveWatchdogBackoff);
  const trigger =
    typeof options.trigger === 'string' && options.trigger.trim()
      ? options.trigger.trim()
      : 'manual';

  if (engineState.status === 'running' && engineState.child) {
    return createEngineStatusResponse(true);
  }

  if (engineState.status === 'starting') {
    return createEngineStatusResponse(true);
  }

  clearEngineRestartTimer();
  engineState.allowAutoRestart = true;
  if (!preserveWatchdogBackoff) {
    engineState.restartAttempts = 0;
    engineState.lastUnexpectedExitAtMs = null;
  }

  const runtime = await resolveEngineRuntimeConfig();
  if (!runtime.ok) {
    appendEngineLog('system', runtime.error);
    setEngineStatus('error', { error: runtime.error, pid: null });
    return createEngineStatusResponse(false, runtime.error);
  }

  telemetryState.lastHello = null;
  clearTelemetryScans();

  setEngineStatus('starting', {
    error: null,
    pid: null,
    binaryPath: runtime.binaryPath,
    args: runtime.args,
  });

  let child;
  try {
    child = spawn(runtime.binaryPath, runtime.args, {
      cwd: path.dirname(runtime.binaryPath),
      env: runtime.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendEngineLog('system', `Failed to spawn engine: ${message}`);
    setEngineStatus('error', { error: message, pid: null });
    return createEngineStatusResponse(false, message);
  }

  engineState.child = child;
  engineState.pid = child.pid ?? null;
  engineState.stopping = false;

  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      lines.forEach((line) => appendEngineLog('stdout', line));
    });
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      lines.forEach((line) => appendEngineLog('stderr', line));
    });
  }

  child.once('spawn', () => {
    appendEngineLog(
      'system',
      `Engine started (pid=${engineState.pid ?? 'unknown'}) using ${runtime.binaryPath} (trigger=${trigger})`,
    );
    appendEngineLog('system', `Engine data dir: ${runtime.dataDir}`);
    if (runtime.samplesDir) {
      appendEngineLog('system', `Engine samples dir: ${runtime.samplesDir}`);
    }
    if (runtime.libsDir) {
      appendEngineLog('system', `Engine runtime libs dir: ${runtime.libsDir}`);
    }
    setEngineStatus('running', {
      error: null,
      pid: engineState.pid,
      binaryPath: runtime.binaryPath,
      args: runtime.args,
    });
  });

  child.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    appendEngineLog('stderr', `Engine process error: ${message}`);
    engineState.lastError = message;
    if (engineState.status !== 'stopped' && engineState.status !== 'stopping') {
      setEngineStatus('error', {
        error: message,
        pid: engineState.pid,
      });
    }
  });

  child.on('exit', (code, signal) => {
    const expectedStop = engineState.stopping;
    appendEngineLog(
      'system',
      `Engine exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}, expected=${expectedStop})`,
    );

    engineState.child = null;
    engineState.pid = null;
    engineState.stopping = false;

    if (expectedStop) {
      setEngineStatus('stopped', { error: null, pid: null });
      return;
    }

    const exitMessage = `Engine exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
    setEngineStatus('error', { error: exitMessage, pid: null });
    scheduleEngineRestart(exitMessage);
  });

  return createEngineStatusResponse(true);
}

async function stopEngine(reason = 'manual') {
  engineState.allowAutoRestart = false;
  resetEngineRestartBackoff();

  if (!engineState.child) {
    if (engineState.status !== 'stopped') {
      setEngineStatus('stopped', { error: null, pid: null });
    }
    return createEngineStatusResponse(true);
  }

  if (engineState.stopping) {
    return createEngineStatusResponse(true);
  }

  const child = engineState.child;
  engineState.stopping = true;
  setEngineStatus('stopping', { pid: child.pid ?? null });
  appendEngineLog('system', `Stopping engine (reason=${reason})`);

  return new Promise((resolve) => {
    let settled = false;
    let forceTimer = null;

    const finish = (ok, error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      resolve(createEngineStatusResponse(ok, error));
    };

    const onExit = () => {
      child.removeListener('exit', onExit);
      finish(true);
    };

    child.once('exit', onExit);

    const signaled = child.kill('SIGTERM');
    if (!signaled) {
      child.removeListener('exit', onExit);
      engineState.stopping = false;
      const error = 'failed_to_signal_engine_process';
      appendEngineLog('stderr', error);
      setEngineStatus('error', { error, pid: engineState.pid });
      finish(false, error);
      return;
    }

    forceTimer = setTimeout(() => {
      if (!engineState.child || engineState.child.pid !== child.pid) {
        return;
      }

      appendEngineLog('system', 'Engine did not exit after SIGTERM; forcing SIGKILL.');
      try {
        child.kill('SIGKILL');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendEngineLog('stderr', `Failed to SIGKILL engine process: ${message}`);
      }
    }, 5000);
  });
}

async function restartEngine() {
  const stopResult = await stopEngine('restart');
  if (!stopResult.ok && engineState.child) {
    return stopResult;
  }
  return startEngine({ trigger: 'restart' });
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

function isChannelNumber(value, channelCount) {
  return Number.isInteger(value) && value >= 1 && value <= channelCount;
}

function channelToOscAddress(channel) {
  return `${oscState.channelPrefix}/${String(channel).padStart(2, '0')}`;
}

function createOscStatusResponse(ok, error) {
  return {
    ok,
    oscReady: Boolean(oscState.ready),
    targetHost: oscState.targetHost,
    targetPort: oscState.targetPort,
    error: error || oscState.lastError || undefined,
  };
}

function createTelemetryStatusResponse(ok, error) {
  const helloPayload = telemetryState.lastHello
    ? {
        ...telemetryState.lastHello,
        args: Array.isArray(telemetryState.lastHello.args)
          ? [...telemetryState.lastHello.args]
          : [],
      }
    : undefined;
  const scanPayload = telemetryState.lastScan
    ? {
        ...telemetryState.lastScan,
        activeGrainIndices: Array.isArray(telemetryState.lastScan.activeGrainIndices)
          ? [...telemetryState.lastScan.activeGrainIndices]
          : [],
        activeGrainNormPositions: Array.isArray(telemetryState.lastScan.activeGrainNormPositions)
          ? [...telemetryState.lastScan.activeGrainNormPositions]
          : [],
      }
    : undefined;

  return {
    ok,
    telemetryReady: Boolean(telemetryState.ready),
    listenHost: telemetryState.listenHost,
    listenPort: telemetryState.listenPort,
    helloAddress: telemetryState.helloAddress,
    scanAddress: telemetryState.scanAddress,
    lastHello: helloPayload,
    lastScan: scanPayload,
    error: error || telemetryState.lastError || undefined,
  };
}

function appendTelemetryScan(payload) {
  telemetryState.lastScan = payload;
  telemetryState.scanBuffer.push(payload);
  if (telemetryState.scanBuffer.length > 12000) {
    telemetryState.scanBuffer.splice(0, telemetryState.scanBuffer.length - 12000);
  }
}

function clearTelemetryScans() {
  telemetryState.scanBuffer = [];
  telemetryState.lastScan = null;
}

function parseHelloArgsMap(helloPayload) {
  const map = {};
  const args = Array.isArray(helloPayload?.args) ? helloPayload.args : [];
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
      activeGrainMax: 0,
    };
  }

  let minPlayhead = Infinity;
  let maxPlayhead = -Infinity;
  let minScanHead = Infinity;
  let maxScanHead = -Infinity;
  let minScanRange = Infinity;
  let maxScanRange = -Infinity;
  let activeGrainMax = 0;

  for (const scan of safeScans) {
    const playheadNorm = Number(scan?.playheadNorm);
    const scanHeadNorm = Number(scan?.scanHeadNorm);
    const scanRangeNorm = Number(scan?.scanRangeNorm);
    const activeGrainCount = Number(scan?.activeGrainCount);

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
    if (Number.isFinite(activeGrainCount)) {
      activeGrainMax = Math.max(activeGrainMax, Math.max(0, Math.trunc(activeGrainCount)));
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
    activeGrainMax,
  };
}

async function captureTelemetryScanWindow(windowMs, options = {}) {
  const minCount = parseBoundedInt(options.minCount, 6, 1, 5000);
  const timeoutMs = parseBoundedInt(options.timeoutMs, windowMs + 3000, 500, 120000);
  const startIndex = telemetryState.scanBuffer.length;
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + timeoutMs;

  while (Date.now() < deadlineMs) {
    const elapsed = Date.now() - startedAtMs;
    const count = telemetryState.scanBuffer.length - startIndex;
    if (elapsed >= windowMs && count >= minCount) {
      break;
    }
    await sleep(STEP1_VALIDATION_POLL_INTERVAL_MS);
  }

  const scans = telemetryState.scanBuffer.slice(startIndex);
  return {
    startedAtMs,
    completedAtMs: Date.now(),
    scans,
    stats: computeScanStats(scans),
  };
}

async function waitForTelemetryHello(sinceTimestampMs = 0, timeoutMs = STEP1_VALIDATION_TIMEOUT_MS) {
  const deadlineMs = Date.now() + timeoutMs;
  let lastHello = telemetryState.lastHello;

  while (Date.now() < deadlineMs) {
    lastHello = telemetryState.lastHello;
    const timestampMs = Number(lastHello?.timestampMs) || 0;
    if (lastHello && timestampMs >= sinceTimestampMs) {
      return {
        hello: lastHello,
        argsMap: parseHelloArgsMap(lastHello),
      };
    }
    await sleep(STEP1_VALIDATION_POLL_INTERVAL_MS);
  }

  throw new Error(`telemetry_hello_timeout(last=${JSON.stringify(lastHello)})`);
}

function closeOscPort() {
  if (!oscState.port) {
    oscState.ready = false;
    return;
  }

  try {
    oscState.port.close();
  } catch {
    // ignore close errors
  }

  oscState.port = null;
  oscState.ready = false;
}

function closeTelemetryPort() {
  if (!telemetryState.port) {
    telemetryState.ready = false;
    return;
  }

  try {
    telemetryState.port.close();
  } catch {
    // ignore close errors
  }

  telemetryState.port = null;
  telemetryState.ready = false;
  clearTelemetryScans();
}

function parseScanTelemetryMessage(message) {
  if (!message || typeof message.address !== 'string') {
    return null;
  }

  if (message.address !== telemetryState.scanAddress) {
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
    source: 'electron',
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

function parseTelemetryArgValue(rawArg) {
  if (
    rawArg &&
    typeof rawArg === 'object' &&
    Object.prototype.hasOwnProperty.call(rawArg, 'value')
  ) {
    return rawArg.value;
  }

  return rawArg;
}

function normalizeTelemetryArg(rawArg) {
  const value = parseTelemetryArgValue(rawArg);
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

function parseHelloTelemetryMessage(message) {
  if (!message || typeof message.address !== 'string') {
    return null;
  }

  if (message.address !== telemetryState.helloAddress) {
    return null;
  }

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

  return {
    source: 'electron',
    timestampMs: Date.now(),
    address: message.address,
    args,
  };
}

function broadcastTelemetryScan(payload) {
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('granuPose:telemetry:scan', payload);
    }
  }
}

function broadcastTelemetryHello(payload) {
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('granuPose:telemetry:hello', payload);
    }
  }
}

function openTelemetryPort() {
  closeTelemetryPort();

  const port = new osc.UDPPort({
    localAddress: telemetryState.listenHost,
    localPort: telemetryState.listenPort,
    metadata: true,
  });

  telemetryState.port = port;
  telemetryState.ready = false;

  port.on('ready', () => {
    telemetryState.ready = true;
    telemetryState.lastError = null;
    console.log(
      `[electron-telemetry] OSC listener ready on ${telemetryState.listenHost}:${telemetryState.listenPort}`,
    );
  });

  port.on('error', (error) => {
    telemetryState.ready = false;
    telemetryState.lastError = error instanceof Error ? error.message : String(error);
    console.error('[electron-telemetry] OSC error:', error);
  });

  port.on('message', (message) => {
    const helloPayload = parseHelloTelemetryMessage(message);
    if (helloPayload) {
      telemetryState.lastHello = helloPayload;
      broadcastTelemetryHello(helloPayload);
      return;
    }

    const payload = parseScanTelemetryMessage(message);
    if (!payload) {
      return;
    }
    appendTelemetryScan(payload);
    broadcastTelemetryScan(payload);
  });

  try {
    port.open();
    return true;
  } catch (error) {
    telemetryState.ready = false;
    telemetryState.lastError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

function openOscPort() {
  if (oscState.opening) {
    return oscState.opening;
  }

  oscState.opening = new Promise((resolve, reject) => {
    const port = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: 0,
      remoteAddress: oscState.targetHost,
      remotePort: oscState.targetPort,
      metadata: true,
    });

    let settled = false;
    let timeoutHandle = null;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      port.off('ready', onReady);
      port.off('error', onOpenError);
    };

    const onReady = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      oscState.port = port;
      oscState.ready = true;
      oscState.lastError = null;

      port.on('error', (error) => {
        oscState.ready = false;
        oscState.lastError = error instanceof Error ? error.message : String(error);
        console.error('[electron-osc] UDP error:', error);
      });

      resolve(true);
    };

    const onOpenError = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      oscState.ready = false;
      oscState.lastError = error instanceof Error ? error.message : String(error);

      try {
        port.close();
      } catch {
        // ignore close errors
      }

      reject(error);
    };

    port.on('ready', onReady);
    port.on('error', onOpenError);
    port.open();

    timeoutHandle = setTimeout(() => {
      onOpenError(new Error('OSC open timeout'));
    }, 2000);
  })
    .finally(() => {
      oscState.opening = null;
    });

  return oscState.opening;
}

async function ensureOscPort() {
  if (oscState.port && oscState.ready) {
    return true;
  }

  try {
    await openOscPort();
    return true;
  } catch (error) {
    oscState.lastError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

async function configureOsc(payload = {}) {
  const nextHost = normalizeHost(payload.targetHost);
  const nextPort = payload.targetPort == null ? null : parsePort(payload.targetPort, oscState.targetPort);

  if (nextHost) {
    oscState.targetHost = nextHost;
  }

  if (nextPort) {
    oscState.targetPort = nextPort;
  }

  closeOscPort();
  const ready = await ensureOscPort();
  return createOscStatusResponse(ready, ready ? undefined : 'failed_to_open_osc_port');
}

async function sendOscChannel(payload = {}) {
  const channel = Number(payload.channel);
  const value = clamp01(payload.value);

  if (!isChannelNumber(channel, oscState.channelCount)) {
    return {
      ok: false,
      channel,
      value,
      error: 'invalid_channel',
    };
  }

  const ready = await ensureOscPort();
  if (!ready || !oscState.port) {
    return {
      ok: false,
      channel,
      value,
      error: 'osc_not_ready',
    };
  }

  const address = channelToOscAddress(channel);

  try {
    oscState.port.send({
      address,
      args: [{ type: 'f', value }],
    });

    return {
      ok: true,
      channel,
      value,
      address,
    };
  } catch (error) {
    oscState.ready = false;
    oscState.lastError = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      channel,
      value,
      address,
      error: oscState.lastError,
    };
  }
}

function normalizeOscArg(arg) {
  if (!arg || typeof arg !== 'object') {
    return null;
  }

  const type = typeof arg.type === 'string' ? arg.type : '';
  if (!['f', 'i', 'd', 's'].includes(type)) {
    return null;
  }

  if (type === 's') {
    return {
      type: 's',
      value: String(arg.value ?? ''),
    };
  }

  const numeric = Number(arg.value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (type === 'i') {
    return {
      type: 'i',
      value: Math.trunc(numeric),
    };
  }

  return {
    type,
    value: numeric,
  };
}

async function sendOscMessage(payload = {}) {
  const address =
    typeof payload.address === 'string' ? payload.address.trim() : '';

  if (!address.startsWith('/')) {
    return {
      ok: false,
      address,
      error: 'invalid_address',
    };
  }

  const rawArgs = Array.isArray(payload.args) ? payload.args : [];
  const args = [];
  for (const rawArg of rawArgs) {
    const arg = normalizeOscArg(rawArg);
    if (!arg) {
      return {
        ok: false,
        address,
        error: 'invalid_arg',
      };
    }
    args.push(arg);
  }

  const ready = await ensureOscPort();
  if (!ready || !oscState.port) {
    return {
      ok: false,
      address,
      error: 'osc_not_ready',
    };
  }

  try {
    oscState.port.send({
      address,
      args,
    });

    return {
      ok: true,
      address,
    };
  } catch (error) {
    oscState.ready = false;
    oscState.lastError = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      address,
      error: oscState.lastError,
    };
  }
}

function ensureMidiEngine() {
  if (midiState.engine) {
    return midiState.engine;
  }

  try {
    midiState.engine = JZZ();
    return midiState.engine;
  } catch (error) {
    midiState.lastError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

function getMidiOutputs() {
  const engine = ensureMidiEngine();
  if (!engine) {
    return [];
  }

  try {
    const info = engine.info();
    const outputs = Array.isArray(info?.outputs) ? info.outputs : [];
    return outputs.map((output) => ({
      id: typeof output.id === 'string' && output.id.length > 0 ? output.id : String(output.name || ''),
      name: String(output.name || output.id || 'MIDI Output'),
      state: 'connected',
    }));
  } catch (error) {
    midiState.lastError = error instanceof Error ? error.message : String(error);
    return [];
  }
}

function createMidiStatusResponse(ok, error) {
  return {
    ok,
    midiReady: Boolean(midiState.ready),
    deviceId: midiState.deviceId,
    midiChannel: midiState.midiChannel,
    ccStart: midiState.ccStart,
    outputs: getMidiOutputs(),
    error: error || midiState.lastError || undefined,
  };
}

function closeMidiOutput() {
  if (!midiState.output) {
    midiState.ready = false;
    return;
  }

  try {
    if (typeof midiState.output.close === 'function') {
      midiState.output.close();
    }
  } catch {
    // ignore close errors
  }

  midiState.output = null;
  midiState.ready = false;
}

function openMidiOutput(deviceId) {
  return new Promise((resolve, reject) => {
    const engine = ensureMidiEngine();
    if (!engine) {
      reject(new Error('midi_engine_not_available'));
      return;
    }

    const outputs = getMidiOutputs();
    const target = outputs.find((output) => output.id === deviceId || output.name === deviceId);
    const selector = target?.name || deviceId || undefined;
    const request = selector ? engine.openMidiOut(selector) : engine.openMidiOut();

    request
      .or(function onError() {
        reject(new Error(this.err ? this.err() : 'midi_open_failed'));
      })
      .and(function onSuccess() {
        resolve(this);
      });
  });
}

async function ensureMidiOutput() {
  if (midiState.output && midiState.ready) {
    return true;
  }

  const outputs = getMidiOutputs();
  if (outputs.length === 0) {
    midiState.lastError = 'no_midi_outputs_available';
    midiState.ready = false;
    return false;
  }

  const targetId = midiState.deviceId || outputs[0].id;
  midiState.deviceId = targetId;

  try {
    midiState.output = await openMidiOutput(targetId);
    midiState.ready = true;
    midiState.lastError = null;
    return true;
  } catch (error) {
    midiState.lastError = error instanceof Error ? error.message : String(error);
    midiState.output = null;
    midiState.ready = false;
    return false;
  }
}

async function configureMidi(payload = {}) {
  if (typeof payload.deviceId === 'string') {
    midiState.deviceId = payload.deviceId.trim();
  }

  if (payload.midiChannel != null) {
    midiState.midiChannel = parseBoundedInt(payload.midiChannel, midiState.midiChannel, 1, 16);
  }

  if (payload.ccStart != null) {
    midiState.ccStart = parseBoundedInt(payload.ccStart, midiState.ccStart, 0, 127);
  }

  closeMidiOutput();
  const ready = await ensureMidiOutput();
  return createMidiStatusResponse(ready, ready ? undefined : 'failed_to_open_midi_output');
}

async function sendMidiChannel(payload = {}) {
  const channel = Number(payload.channel);
  const value = clamp01(payload.value);

  if (!isChannelNumber(channel, midiState.channelCount)) {
    return {
      ok: false,
      channel,
      value,
      error: 'invalid_channel',
    };
  }

  const ready = await ensureMidiOutput();
  if (!ready || !midiState.output) {
    return {
      ok: false,
      channel,
      value,
      error: 'midi_not_ready',
    };
  }

  const controller = Math.max(0, Math.min(127, midiState.ccStart + (channel - 1)));
  const ccValue = Math.round(value * 127);
  const status = 0xb0 + (midiState.midiChannel - 1);

  try {
    midiState.output.send([status, controller, ccValue]);
    return {
      ok: true,
      channel,
      value,
      controller,
      midiChannel: midiState.midiChannel,
    };
  } catch (error) {
    midiState.ready = false;
    midiState.lastError = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      channel,
      value,
      controller,
      midiChannel: midiState.midiChannel,
      error: midiState.lastError,
    };
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    show: !STEP1_VALIDATION_HIDE_WINDOW,
    backgroundColor: '#12141d',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (isDev) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL);
    if (!VALIDATION_ENABLED) {
      window.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  if (STEP1_VALIDATION_HIDE_WINDOW) {
    window.once('ready-to-show', () => {
      window.hide();
    });
  }

  mainWindowRef = window;
  window.on('closed', () => {
    if (mainWindowRef === window) {
      mainWindowRef = null;
    }
  });

  return window;
}

ipcMain.handle('granuPose:osc:configure', async (_event, payload) => {
  return configureOsc(payload || {});
});

ipcMain.handle('granuPose:osc:status', async () => {
  return createOscStatusResponse(Boolean(oscState.ready));
});

ipcMain.handle('granuPose:osc:sendChannel', async (_event, payload) => {
  return sendOscChannel(payload || {});
});

ipcMain.handle('granuPose:osc:sendMessage', async (_event, payload) => {
  return sendOscMessage(payload || {});
});

ipcMain.handle('granuPose:telemetry:status', async () => {
  return createTelemetryStatusResponse(Boolean(telemetryState.ready));
});

ipcMain.handle('granuPose:engine:start', async () => {
  return startEngine();
});

ipcMain.handle('granuPose:engine:stop', async () => {
  return stopEngine('ipc_stop');
});

ipcMain.handle('granuPose:engine:restart', async () => {
  return restartEngine();
});

ipcMain.handle('granuPose:engine:status', async () => {
  return createEngineStatusResponse(true);
});

ipcMain.handle('granuPose:engine:getLogs', async (_event, payload) => {
  return getEngineLogs(payload || {});
});

ipcMain.handle('granuPose:midi:configure', async (_event, payload) => {
  return configureMidi(payload || {});
});

ipcMain.handle('granuPose:midi:status', async () => {
  return createMidiStatusResponse(Boolean(midiState.ready));
});

ipcMain.handle('granuPose:midi:listOutputs', async () => {
  return {
    ok: true,
    outputs: getMidiOutputs(),
  };
});

ipcMain.handle('granuPose:midi:sendChannel', async (_event, payload) => {
  return sendMidiChannel(payload || {});
});

ipcMain.handle('granuPose:audio:listOutputs', async () => {
  try {
    const names = await listSystemAudioOutputNames();
    return {
      ok: true,
      outputs: names.map((name, index) => ({
        id: createSystemAudioOutputId(name, index),
        name,
        state: 'connected',
      })),
    };
  } catch (error) {
    return {
      ok: false,
      outputs: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('granuPose:audio:listRecordings', async (_event, payload) => {
  try {
    const directoryPath =
      typeof payload?.directoryPath === 'string' ? payload.directoryPath.trim() : '';
    if (!directoryPath) {
      return {
        ok: false,
        recordings: [],
        error: 'A recording directory path is required.',
      };
    }

    const limit = parseBoundedInt(payload?.limit, 64, 1, 256);
    const allFiles = await listRecordFiles(directoryPath);
    const recordings = allFiles
      .sort((left, right) => (Number(right.mtimeMs) || 0) - (Number(left.mtimeMs) || 0))
      .slice(0, limit)
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        sizeBytes: Number(entry.sizeBytes) || 0,
        modifiedAtMs: Number(entry.mtimeMs) || 0,
      }));

    return {
      ok: true,
      recordings,
    };
  } catch (error) {
    return {
      ok: false,
      recordings: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('granuPose:audio:readRecordingAsBase64', async (_event, payload) => {
  try {
    const filePath =
      typeof payload?.filePath === 'string' ? payload.filePath.trim() : '';
    if (!filePath) {
      return {
        ok: false,
        error: 'A recording file path is required.',
      };
    }

    const maxBytes = parseBoundedInt(
      payload?.maxBytes,
      25 * 1024 * 1024,
      1024,
      250 * 1024 * 1024,
    );
    const fileStats = await fs.stat(filePath);
    if (!fileStats.isFile()) {
      return {
        ok: false,
        error: 'The selected recording path is not a file.',
      };
    }

    if (Number(fileStats.size) > maxBytes) {
      return {
        ok: false,
        error: `Recording file is larger than the configured ${maxBytes} byte limit.`,
      };
    }

    const rawFile = await fs.readFile(filePath);
    return {
      ok: true,
      fileName: path.basename(filePath),
      mimeType: 'audio/wav',
      sizeBytes: Number(fileStats.size) || rawFile.length,
      base64Data: rawFile.toString('base64'),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('granuPose:dialog:pickWavFile', async (_event, payload) => {
  try {
    const focusedWindow =
      BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const defaultPath =
      typeof payload?.defaultPath === 'string' && payload.defaultPath.trim().length > 0
        ? payload.defaultPath.trim()
        : undefined;

    const result = await dialog.showOpenDialog(focusedWindow, {
      title: 'Select WAV Sound File',
      properties: ['openFile'],
      defaultPath,
      filters: [
        { name: 'WAV Files', extensions: ['wav', 'wave'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: true,
        canceled: true,
      };
    }

    return {
      ok: true,
      canceled: false,
      filePath: result.filePaths[0],
    };
  } catch (error) {
    return {
      ok: false,
      canceled: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('granuPose:dialog:readWavFileAsBase64', async (_event, payload) => {
  try {
    const filePath =
      typeof payload?.filePath === 'string' && payload.filePath.trim().length > 0
        ? payload.filePath.trim()
        : '';
    if (!filePath) {
      return {
        ok: false,
        error: 'A WAV file path is required.',
      };
    }

    const rawFile = await fs.readFile(filePath);
    return {
      ok: true,
      base64Data: rawFile.toString('base64'),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('granuPose:dialog:getDefaultStaticWavPath', async () => {
  try {
    const filePath = await resolveDefaultStaticWavPath();
    if (!filePath) {
      return {
        ok: false,
        error:
          'Default static WAV file not found. Set GRANUPOSE_STATIC_WAV_PATH or place EmissionControl2/externalResources/samples/440sine48k.wav next to pose-controller.',
      };
    }

    return {
      ok: true,
      filePath,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('granuPose:dialog:pickDirectory', async () => {
  try {
    const focusedWindow =
      BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;

    const result = await dialog.showOpenDialog(focusedWindow, {
      title: 'Select Output Folder',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: true,
        canceled: true,
      };
    }

    return {
      ok: true,
      canceled: false,
      directoryPath: result.filePaths[0],
    };
  } catch (error) {
    return {
      ok: false,
      canceled: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

app.whenReady().then(async () => {
  openTelemetryPort();
  const mainWindow = createWindow();
  broadcastEngineStatus();

  if (ENGINE_DEFAULTS.autoStart) {
    await startEngine({ trigger: 'autostart' });
  } else {
    appendEngineLog('system', 'Managed engine autostart is disabled.');
  }

  if (VALIDATION_ENABLED) {
    const startValidation = () => {
      if (STEP1_VALIDATION_ENABLED) {
        void runStep1ValidationHarness(mainWindow);
        return;
      }
      if (STEP2_VALIDATION_ENABLED) {
        void runStep2ValidationHarness(mainWindow);
        return;
      }
      if (STEP3_VALIDATION_ENABLED) {
        void runStep3ValidationHarness(mainWindow);
        return;
      }
      if (STEP4_VALIDATION_ENABLED) {
        void runStep4ValidationHarness(mainWindow);
      }
    };
    if (mainWindow.webContents.isLoadingMainFrame()) {
      mainWindow.webContents.once('did-finish-load', startValidation);
    } else {
      startValidation();
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  void stopEngine('before_quit');
});

app.on('window-all-closed', (event) => {
  if (process.platform !== 'darwin') {
    if (quitInProgress) {
      return;
    }

    quitInProgress = true;
    event.preventDefault();
    closeOscPort();
    closeTelemetryPort();
    closeMidiOutput();

    void stopEngine('window_all_closed').finally(() => {
      app.quit();
    });
  }
});
