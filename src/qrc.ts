import net from 'node:net';
import { EventEmitter } from 'node:events';

export interface QrcClientOptions {
  host: string;
  port?: number;
  /** Keepalive interval in ms. QRC closes idle sockets after 60s; default 30s. */
  keepAliveMs?: number;
  /** Per-request timeout in ms (default 10s). */
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class QrcError extends Error {
  code?: number;
  data?: unknown;
  constructor(err: unknown) {
    const o = (err && typeof err === 'object') ? err as Record<string, unknown> : null;
    super(o ? String(o.message ?? JSON.stringify(err)) : String(err));
    this.name = 'QrcError';
    if (o) {
      this.code = typeof o.code === 'number' ? o.code : undefined;
      this.data = o.data;
    }
  }
}

/**
 * Q-SYS Remote Control (QRC) client.
 * Speaks JSON-RPC 2.0 over a raw TCP socket (default port 1710), framed with
 * null terminators — the wire format QSC documents and that the Designer
 * Emulate-mode soft-core serves on localhost.
 *
 * Events: 'engineStatus' (params), 'notification' (full message), 'error', 'close'.
 */
export class QrcClient extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly keepAliveMs: number;
  private readonly requestTimeoutMs: number;
  private socket: net.Socket | null = null;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private connected = false;

  constructor(opts: QrcClientOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port ?? 1710;
    this.keepAliveMs = opts.keepAliveMs ?? 30_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  }

  isConnected(): boolean {
    return this.connected;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      sock.setEncoding('utf8');
      const onConnectError = (e: Error) => reject(e);
      sock.once('error', onConnectError);
      sock.once('connect', () => {
        sock.removeListener('error', onConnectError);
        this.socket = sock;
        this.connected = true;
        sock.on('data', (chunk: Buffer | string) => this.onData(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
        sock.on('error', (e: Error) => this.emitError(e));
        sock.on('close', () => this.onClose());
        this.startKeepAlive();
        resolve();
      });
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\0')) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!raw.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        this.emitError(new Error(`QRC parse error: ${raw.slice(0, 200)}`));
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg.id;
    if (typeof id === 'number' && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new QrcError(msg.error));
      else p.resolve(msg.result);
      return;
    }
    // Unsolicited notification (EngineStatus on connect, change-group autopolls, etc.)
    if (typeof msg.method === 'string') {
      if (msg.method === 'EngineStatus') this.emit('engineStatus', msg.params);
      this.emit('notification', msg);
    }
  }

  /** Send a JSON-RPC request and await the correlated response. */
  send(method: string, params?: unknown): Promise<unknown> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error('QRC not connected — call connect() first'));
    }
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? null, id }) + '\0';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`QRC request timed out: ${method} (id ${id})`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(frame);
    });
  }

  /** Fire-and-forget notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    if (!this.socket || !this.connected) return;
    this.socket.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? null }) + '\0');
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => this.notify('NoOp', {}), this.keepAliveMs);
    this.keepAliveTimer.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private onClose(): void {
    this.connected = false;
    this.stopKeepAlive();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('QRC connection closed'));
    }
    this.pending.clear();
    this.emit('close');
  }

  close(): void {
    this.stopKeepAlive();
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    this.connected = false;
  }

  /** Emit 'error' if anyone is listening; otherwise log to stderr instead of throwing. */
  private emitError(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else console.error('[qrc]', err.message);
  }

  // ---- QRC method wrappers ----

  logon(user: string, password: string): Promise<unknown> {
    return this.send('Logon', { User: user, Password: password });
  }

  statusGet(): Promise<EngineStatus> {
    return this.send('StatusGet', 0) as Promise<EngineStatus>;
  }

  getComponents(): Promise<QrcComponent[]> {
    return this.send('Component.GetComponents', null) as Promise<QrcComponent[]>;
  }

  getComponentControls(name: string): Promise<{ Name: string; Controls: QrcControl[] }> {
    return this.send('Component.GetControls', { Name: name }) as Promise<{ Name: string; Controls: QrcControl[] }>;
  }

  getComponent(name: string, controls: string[]): Promise<{ Name: string; Controls: QrcControl[] }> {
    return this.send('Component.Get', {
      Name: name,
      Controls: controls.map((n) => ({ Name: n })),
    }) as Promise<{ Name: string; Controls: QrcControl[] }>;
  }

  setComponent(name: string, controls: Array<{ Name: string; Value: ControlValue; Ramp?: number }>): Promise<unknown> {
    return this.send('Component.Set', { Name: name, Controls: controls });
  }

  getControl(names: string[]): Promise<QrcControl[]> {
    return this.send('Control.Get', names) as Promise<QrcControl[]>;
  }

  setControl(name: string, value: ControlValue, ramp?: number): Promise<unknown> {
    const params: Record<string, unknown> = { Name: name, Value: value };
    if (ramp != null) params.Ramp = ramp;
    return this.send('Control.Set', params);
  }

  changeGroupAddControl(id: string, controls: string[]): Promise<unknown> {
    return this.send('ChangeGroup.AddControl', { Id: id, Controls: controls });
  }

  changeGroupAddComponentControl(id: string, component: string, controls: string[]): Promise<unknown> {
    return this.send('ChangeGroup.AddComponentControl', {
      Id: id,
      Component: { Name: component, Controls: controls.map((n) => ({ Name: n })) },
    });
  }

  changeGroupPoll(id: string): Promise<{ Id: string; Changes: QrcControl[] }> {
    return this.send('ChangeGroup.Poll', { Id: id }) as Promise<{ Id: string; Changes: QrcControl[] }>;
  }

  changeGroupDestroy(id: string): Promise<unknown> {
    return this.send('ChangeGroup.Destroy', { Id: id });
  }
}

export type ControlValue = number | string | boolean;

export interface EngineStatus {
  Platform: string;
  State: string;
  DesignName: string;
  DesignCode: string;
  IsRedundant: boolean;
  IsEmulator: boolean;
  Status: { Code: number; String: string };
}

export interface QrcComponent {
  ID?: string;
  Name: string;
  Type: string;
  Properties?: Array<{ Name: string; Value: string; PrettyName?: string }>;
}

export interface QrcControl {
  Name: string;
  Value: ControlValue;
  String?: string;
  Position?: number;
}
