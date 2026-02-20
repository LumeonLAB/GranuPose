export interface ElectronOscConfigurePayload {
  targetHost?: string;
  targetPort?: number;
}

export interface ElectronOscChannelPayload {
  channel: number;
  value: number;
}

export interface ElectronOscMessageArg {
  type: 'f' | 'i' | 'd' | 's';
  value: number | string;
}

export interface ElectronOscMessagePayload {
  address: string;
  args?: ElectronOscMessageArg[];
}

export interface ElectronOscStatusResponse {
  ok: boolean;
  oscReady: boolean;
  targetHost: string;
  targetPort: number;
  error?: string;
}

export interface ElectronOscSendResponse {
  ok: boolean;
  channel: number;
  value: number;
  address?: string;
  error?: string;
}

export interface ElectronOscMessageResponse {
  ok: boolean;
  address: string;
  error?: string;
}

export interface ElectronScanTelemetryPayload {
  source?: 'electron' | 'bridge';
  timestampMs?: number;
  playheadNorm: number;
  scanHeadNorm: number;
  scanRangeNorm: number;
  soundFileFrames?: number | null;
  activeGrainCount?: number;
  activeGrainIndices?: number[];
  activeGrainNormPositions?: number[];
}

export interface ElectronHelloTelemetryPayload {
  source?: 'electron' | 'bridge';
  timestampMs: number;
  address: string;
  args: Array<string | number | boolean>;
}

export interface ElectronTelemetryStatusResponse {
  ok: boolean;
  telemetryReady: boolean;
  listenHost: string;
  listenPort: number;
  helloAddress: string;
  scanAddress: string;
  lastHello?: ElectronHelloTelemetryPayload;
  error?: string;
}

export type ElectronEngineRuntimeStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error';

export interface ElectronEngineStatusResponse {
  ok: boolean;
  status: ElectronEngineRuntimeStatus;
  pid: number | null;
  binaryPath?: string;
  args: string[];
  startedAtMs?: number;
  stoppedAtMs?: number;
  autoStartEnabled: boolean;
  autoRestartEnabled?: boolean;
  restartAttempts?: number;
  restartMaxAttempts?: number;
  lastError?: string;
}

export interface ElectronEngineLogEntry {
  timestampMs: number;
  source: 'stdout' | 'stderr' | 'system';
  line: string;
}

export interface ElectronEngineLogsResponse {
  ok: boolean;
  entries: ElectronEngineLogEntry[];
}

export interface ElectronEngineLogRequest {
  limit?: number;
}

export interface ElectronMidiConfigurePayload {
  deviceId?: string;
  midiChannel?: number;
  ccStart?: number;
}

export interface ElectronMidiChannelPayload {
  channel: number;
  value: number;
}

export interface ElectronMidiOutputDevice {
  id: string;
  name: string;
  state: 'connected' | 'disconnected';
}

export interface ElectronMidiStatusResponse {
  ok: boolean;
  midiReady: boolean;
  deviceId: string;
  midiChannel: number;
  ccStart: number;
  outputs: ElectronMidiOutputDevice[];
  error?: string;
}

export interface ElectronMidiListResponse {
  ok: boolean;
  outputs: ElectronMidiOutputDevice[];
  error?: string;
}

export interface ElectronMidiSendResponse {
  ok: boolean;
  channel: number;
  value: number;
  controller?: number;
  midiChannel?: number;
  error?: string;
}

export interface ElectronAudioOutputDevice {
  id: string;
  name: string;
  state: 'connected' | 'disconnected';
}

export interface ElectronAudioListResponse {
  ok: boolean;
  outputs: ElectronAudioOutputDevice[];
  error?: string;
}

export interface ElectronAudioRecordingEntry {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAtMs: number;
}

export interface ElectronAudioListRecordingsRequest {
  directoryPath: string;
  limit?: number;
}

export interface ElectronAudioListRecordingsResponse {
  ok: boolean;
  recordings: ElectronAudioRecordingEntry[];
  error?: string;
}

export interface ElectronAudioReadRecordingRequest {
  filePath: string;
  maxBytes?: number;
}

export interface ElectronAudioReadRecordingResponse {
  ok: boolean;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  base64Data?: string;
  error?: string;
}

export interface ElectronDialogFileResponse {
  ok: boolean;
  canceled: boolean;
  filePath?: string;
  error?: string;
}

export interface ElectronDialogFileRequest {
  defaultPath?: string;
}

export interface ElectronDialogReadFileRequest {
  filePath: string;
}

export interface ElectronDialogReadFileResponse {
  ok: boolean;
  base64Data?: string;
  error?: string;
}

export interface ElectronDialogStaticWavResponse {
  ok: boolean;
  filePath?: string;
  error?: string;
}

export interface ElectronDialogDirectoryResponse {
  ok: boolean;
  canceled: boolean;
  directoryPath?: string;
  error?: string;
}

export interface GranuPoseElectronApi {
  versions: {
    chrome: string;
    electron: string;
    node: string;
  };
  osc: {
    configure(payload?: ElectronOscConfigurePayload): Promise<ElectronOscStatusResponse>;
    getStatus(): Promise<ElectronOscStatusResponse>;
    sendChannel(payload: ElectronOscChannelPayload): Promise<ElectronOscSendResponse>;
    sendMessage(payload: ElectronOscMessagePayload): Promise<ElectronOscMessageResponse>;
  };
  telemetry: {
    getStatus(): Promise<ElectronTelemetryStatusResponse>;
    subscribeHello(listener: (payload: ElectronHelloTelemetryPayload) => void): () => void;
    subscribeScan(listener: (payload: ElectronScanTelemetryPayload) => void): () => void;
  };
  engine: {
    start(): Promise<ElectronEngineStatusResponse>;
    stop(): Promise<ElectronEngineStatusResponse>;
    restart(): Promise<ElectronEngineStatusResponse>;
    getStatus(): Promise<ElectronEngineStatusResponse>;
    getLogs(payload?: ElectronEngineLogRequest): Promise<ElectronEngineLogsResponse>;
    subscribeStatus(listener: (payload: ElectronEngineStatusResponse) => void): () => void;
    subscribeLogs(listener: (payload: ElectronEngineLogEntry) => void): () => void;
  };
  midi: {
    configure(payload?: ElectronMidiConfigurePayload): Promise<ElectronMidiStatusResponse>;
    getStatus(): Promise<ElectronMidiStatusResponse>;
    listOutputs(): Promise<ElectronMidiListResponse>;
    sendChannel(payload: ElectronMidiChannelPayload): Promise<ElectronMidiSendResponse>;
  };
  audio: {
    listOutputs(): Promise<ElectronAudioListResponse>;
    listRecordings(
      payload: ElectronAudioListRecordingsRequest,
    ): Promise<ElectronAudioListRecordingsResponse>;
    readRecordingAsBase64(
      payload: ElectronAudioReadRecordingRequest,
    ): Promise<ElectronAudioReadRecordingResponse>;
  };
  dialog: {
    pickWavFile(payload?: ElectronDialogFileRequest): Promise<ElectronDialogFileResponse>;
    readWavFileAsBase64(
      payload: ElectronDialogReadFileRequest,
    ): Promise<ElectronDialogReadFileResponse>;
    getDefaultStaticWavPath(): Promise<ElectronDialogStaticWavResponse>;
    pickDirectory(): Promise<ElectronDialogDirectoryResponse>;
  };
}

declare global {
  interface Window {
    granuPose?: GranuPoseElectronApi;
  }
}
