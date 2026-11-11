// The viewer WebSocket (/ws/viewer): connects, reconnects with backoff, shows the link status.
import { isJsonObject, type ViewerClientFrame, type ViewerServerFrame } from "@agent-bus/protocol";
import { dom } from "./dom";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

export interface ViewerHandlers {
  /** The socket is open; `reconnected` when an earlier connection of this page was open before. */
  onOpen(reconnected: boolean): void;
  onFrame(frame: ViewerServerFrame): void;
}

let handlers: ViewerHandlers | undefined;
let socket: WebSocket | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: Timer | null = null;
let everConnected = false;

export function setLinkStatus(stateName: "connecting" | "live" | "offline", text: string): void {
  dom.linkStatus.dataset.state = stateName;
  dom.linkStatus.textContent = text;
}

/** Connects (once, at boot); the socket reconnects on its own after that. */
export function connectViewer(viewerHandlers: ViewerHandlers): void {
  handlers = viewerHandlers;
  connect();
}

/** Sends `frame` when the socket is open; false when it is not. */
export function sendViewer(frame: ViewerClientFrame): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

function connect(): void {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/viewer`;
  const ws = new WebSocket(url);
  socket = ws;
  setLinkStatus("connecting", everConnected ? "reconnecting…" : "connecting…");

  ws.addEventListener("open", () => {
    reconnectDelay = RECONNECT_MIN_MS;
    setLinkStatus("live", "live");
    const reconnected = everConnected;
    everConnected = true;
    handlers?.onOpen(reconnected);
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isJsonObject(frame)) return;
    handlers?.onFrame(frame as ViewerServerFrame);
  });
  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    socket = null;
    setLinkStatus("offline", `offline — retrying in ${Math.round(reconnectDelay / 1000)}s`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  });
}

window.addEventListener("online", () => {
  if (socket || reconnectTimer === null) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  connect();
});
