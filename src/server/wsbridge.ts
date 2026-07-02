/**
 * Bridges Bun's native websockets to the `ws`-shaped server API that
 * `@automerge/automerge-repo-network-websocket`'s WebSocketServerAdapter
 * expects (`server.on("connection")`, per-socket `message`/`close`/`pong`
 * events, `send`/`ping`/`terminate`, `readyState`, mutable `isAlive`).
 *
 * Using Bun.serve's websockets directly keeps one server for HTTP + sync and
 * avoids depending on `ws`'s Node internals under Bun.
 */
import { EventEmitter } from "node:events";
import type { ServerWebSocket, WebSocketHandler } from "bun";

export interface SyncSocketData {
  shim?: SocketShim;
}

export class SocketShim extends EventEmitter {
  /** WebSocketServerAdapter's keepalive flips this on pong. */
  isAlive = true;

  constructor(private ws: ServerWebSocket<SyncSocketData>) {
    super();
  }

  get readyState(): number {
    return this.ws.readyState; // 0..3, same numbering as `ws`
  }

  send(data: ArrayBufferLike | Uint8Array): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.ws.send(bytes);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
  }

  terminate(): void {
    try {
      this.ws.terminate();
    } catch {}
  }

  ping(): void {
    try {
      this.ws.ping();
    } catch {}
  }
}

export class BunWSServer extends EventEmitter {
  clients = new Set<SocketShim>();

  /** Plug straight into Bun.serve({ websocket }). */
  readonly websocket: WebSocketHandler<SyncSocketData> = {
    open: ws => {
      const shim = new SocketShim(ws);
      ws.data.shim = shim;
      this.clients.add(shim);
      this.emit("connection", shim);
    },
    message: (ws, message) => {
      const shim = ws.data.shim;
      if (!shim) return;
      const bytes = typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      shim.emit("message", bytes);
    },
    close: ws => {
      const shim = ws.data.shim;
      if (!shim) return;
      this.clients.delete(shim);
      shim.emit("close");
    },
    pong: ws => {
      ws.data.shim?.emit("pong");
    },
  };

  shutdown(): void {
    this.emit("close");
    for (const client of [...this.clients]) client.terminate();
    this.clients.clear();
  }
}
