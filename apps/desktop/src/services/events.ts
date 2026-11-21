import { backendEventSchema, type JarvisEvent } from "@/types/contracts";
import { clearBrowserSession, getBrowserSessionToken, isBrowserDeployment } from "@/services/deployment";

export type EventConnectionState = "connecting" | "connected" | "disconnected" | "unavailable";

export class BackendEventStream {
  private socket: WebSocket | undefined;
  private pingTimer: number | undefined;
  private reconnectTimer: number | undefined;
  private closedByUser = false;
  private attempts = 0;

  constructor(
    private readonly onEvent: (event: JarvisEvent) => void,
    private readonly onState: (state: EventConnectionState) => void,
  ) {}

  async connect(): Promise<void> {
    this.closedByUser = false;
    this.onState("connecting");
    let wsUrl: string;
    if (import.meta.env.DEV) {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      wsUrl = `${protocol}//${window.location.host}/ws/events`;
    } else if (window.jarvis) {
      const backend = new URL(await window.jarvis.getBackendBaseUrl());
      backend.protocol = backend.protocol === "https:" ? "wss:" : "ws:";
      backend.pathname = "/ws/events";
      backend.search = "";
      wsUrl = backend.toString();
    } else {
      this.onState("unavailable");
      return;
    }

    try {
      const socket = new WebSocket(wsUrl);
      this.socket = socket;
      socket.addEventListener("open", () => {
        void (async () => {
          if (isBrowserDeployment()) {
            try {
              socket.send(JSON.stringify({ type: "authenticate", token: await getBrowserSessionToken() }));
            } catch {
              socket.close(1008, "Browser session unavailable");
              return;
            }
          }
          if (socket.readyState !== WebSocket.OPEN) return;
          this.attempts = 0;
          this.onState("connected");
          socket.send(JSON.stringify({ type: "ping" }));
          this.pingTimer = window.setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
          }, 25_000);
        })();
      });
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return;
        try {
          const parsed: unknown = JSON.parse(message.data);
          if (parsed && typeof parsed === "object" && "type" in parsed && parsed.type === "pong") return;
          const event = backendEventSchema.safeParse(parsed);
          if (event.success) this.onEvent(event.data as JarvisEvent);
        } catch {
          // Ignore malformed frames; the stream is a notification channel, not authority.
        }
      });
      socket.addEventListener("error", () => this.onState("disconnected"));
      socket.addEventListener("close", (event) => {
        this.clearTimers();
        if (isBrowserDeployment() && event.code === 1008) clearBrowserSession();
        this.onState("disconnected");
        this.scheduleReconnect();
      });
    } catch {
      this.onState("disconnected");
      this.scheduleReconnect();
    }
  }

  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = undefined;
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== undefined) return;
    const delay = Math.min(30_000, 750 * 2 ** this.attempts++);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.pingTimer !== undefined) window.clearInterval(this.pingTimer);
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.pingTimer = undefined;
    this.reconnectTimer = undefined;
  }
}