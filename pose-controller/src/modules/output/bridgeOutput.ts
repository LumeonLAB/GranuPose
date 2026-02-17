export type BridgeConnectionStatus =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'disconnected';

type StatusListener = (status: BridgeConnectionStatus) => void;

interface BridgeOutputClientOptions {
  wsUrl?: string;
  reconnectMs?: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function getDefaultWsUrl(): string {
  const fromEnv = import.meta.env.VITE_BRIDGE_WS_URL;
  if (fromEnv) {
    return fromEnv;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export class BridgeOutputClient {
  private readonly wsUrl: string;
  private readonly reconnectMs: number;
  private socket: WebSocket | null;
  private reconnectTimer: number | null;
  private closed: boolean;
  private status: BridgeConnectionStatus;
  private readonly listeners: Set<StatusListener>;

  constructor(options: BridgeOutputClientOptions = {}) {
    this.wsUrl = options.wsUrl || getDefaultWsUrl();
    this.reconnectMs = options.reconnectMs ?? 2000;
    this.socket = null;
    this.reconnectTimer = null;
    this.closed = false;
    this.status = 'disconnected';
    this.listeners = new Set();
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setStatus(nextStatus: BridgeConnectionStatus): void {
    if (this.status === nextStatus) {
      return;
    }

    this.status = nextStatus;
    this.listeners.forEach((listener) => listener(nextStatus));
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) {
      return;
    }

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectMs);
  }

  connect(): void {
    if (this.closed) {
      return;
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    this.setStatus('connecting');

    try {
      const ws = new WebSocket(this.wsUrl);
      this.socket = ws;

      ws.onopen = () => {
        this.setStatus('connected');
      };

      ws.onclose = () => {
        this.setStatus('disconnected');
        this.scheduleReconnect();
      };

      ws.onerror = () => {
        this.setStatus('disconnected');
      };
    } catch {
      this.setStatus('disconnected');
      this.scheduleReconnect();
    }
  }

  sendChannel(channel: number, value: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload = {
      type: 'channel:set',
      payload: {
        channel,
        value: clamp01(value),
      },
    };

    this.socket.send(JSON.stringify(payload));
  }

  close(): void {
    this.closed = true;

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.setStatus('disconnected');
  }
}

export function createBridgeOutputClientFromEnv(): BridgeOutputClient | null {
  const mode = (import.meta.env.VITE_OUTPUT_MODE || 'bridge').toLowerCase();
  if (mode !== 'bridge') {
    return null;
  }

  return new BridgeOutputClient({
    wsUrl: import.meta.env.VITE_BRIDGE_WS_URL,
  });
}
