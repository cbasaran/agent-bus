"""message-bus plugin for Hermes: the Hermes side of ~/code/message-bus (see PROJECT.md there).

- In the gateway process only: one agent connection (WS /ws/agent, joined by `name`), every delivery
  injected into `session_key` through `ctx.inject_message` (the gateway queues it behind a running
  turn and starts a turn when idle: composer behaviour). Quiet deliveries (@all from other agents
  unless `set all wake`) are added as context to the next turn of that session via `pre_llm_call`.
- In every process: the `message-bus` tool (write / send / set) over plain HTTP.

Config: plugins.entries.message-bus.settings.{url, name, session_key} and
plugins.entries.message-bus.allow_gateway_injection: true (read by Hermes itself).
"""
from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

logger = logging.getLogger("plugins.message-bus")

TOOL_NAME = "message-bus"
STATE_DIR = Path.home() / ".agent-bus"
ID_FILE = STATE_DIR / "hermes-id"  # bus id assigned at join; read by the tool in other processes
RECONNECT_MAX_S = 30.0
RECEIPT_WAIT_MS = 5000  # how long write/send wait for recipients' harnesses to accept the message
HOLD_MAX_S = 900  # inject held messages anyway when the previous injection has not been seen for this long

# Group messages written from this process whose recipients were still pending when the tool returned;
# the gateway bridge turns their later receipt frames into quiet notes (same process: Discord turns run
# inside the gateway).
_awaiting_receipts: dict[int, set[str]] = {}
_awaiting_lock = threading.Lock()

SCHEMA = {
    "name": TOOL_NAME,
    "description": (
        "Talk to the other agents and the humans (@can, @umit) on the shared message bus. "
        # Same text as the cost note in packages/omp-extension/src/index.ts.
        "Every message you send starts a paid model turn for each agent it reaches (@all reaches every agent), so use "
        "the bus sparingly: write only when the recipients need it (a result, a decision, a question, a claim or release "
        "of a shared resource). Do not send acknowledgements, thanks or \"noted/received\" messages, and do not restate "
        "other agents' messages; not replying is the default. Send to the fewest recipients who need it: @id or @{ids} "
        "rather than @all, and only the agents who have to read or act on it. Messages for you "
        "arrive in this conversation on their own as \"[message-bus] #<message_id> @sender → …\" (never poll, and never "
        "read the bus database; use the read ops below). op=reply: answer a message you received: `message_id` (the #number) plus `message` and/or "
        "`files`; it goes to that message's conversation, so you never need to work out an address. "
        "op=write: start or continue a conversation: `to` is \"@all\", \"@id\" or \"@{id1,id2}\" (a group; the "
        "same set always reuses the same conversation), plus `message` and/or `files` (local paths). op=send: the same "
        "as write, with `files` required. Unknown arguments are rejected and nothing is sent; every result says what the "
        "bus stored (text length, file names). op=set: `key` + `value`; settings: all = wake | quiet (whether @all messages "
        "from other agents start a turn for you; default quiet). "
        "Reading (no turns for anyone, only your own tokens): op=inbox: messages sent to you, newest `limit` (default 20), "
        "optionally only after #`since`. op=show: one message by `message_id`, in full, with its files downloaded. "
        "op=history: the last `limit` messages of a conversation: `to` (as you would write to it) or the conversation of "
        "`message_id`. op=search: messages whose text contains `query` and/or from `sender`, newest `limit`, as one-line hits. "
        "show, history and search cover the conversations you are in (and @all); add scope=\"all\" for every conversation."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": ["reply", "write", "send", "set", "inbox", "show", "history", "search"],
                   "description": "reply/write/send a message, set a setting, or read: inbox, show, history, search"},
            "message_id": {"type": "integer", "description": "a message's #number (reply, show, history)"},
            "to": {"type": "string", "description": "\"@all\", \"@id\" or \"@{id1,id2}\" (write/send, history)"},
            "message": {"type": "string", "description": "message text (reply/write; optional caption for send)"},
            "files": {"type": "array", "items": {"type": "string"},
                      "description": "absolute file paths (optional for reply and write)"},
            "key": {"type": "string", "description": "setting name (set)"},
            "value": {"type": "string", "description": "setting value (set)"},
            "query": {"type": "string", "description": "text to find, case-insensitive (search)"},
            "sender": {"type": "string", "description": "only messages from this id (search)"},
            "since": {"type": "integer", "description": "only messages after this #number (inbox)"},
            "limit": {"type": "integer", "description": "how many messages, default 20, at most 100 (inbox, history, search)"},
            "scope": {"type": "string", "enum": ["mine", "all"],
                      "description": "\"mine\" (default): your conversations and @all; \"all\": every conversation"},
        },
        "required": ["op"],
    },
}


def _format_address(ids: list[str]) -> str:
    if not ids:
        return "@all"
    return f"@{ids[0]}" if len(ids) == 1 else "@{" + ",".join(ids) + "}"


def quote_line(quote: dict) -> str:
    """Same text as quoteLine in packages/protocol/src/address.ts."""
    one_line = " ".join(str(quote.get("text") or "").split())
    text = one_line if len(one_line) <= 160 else one_line[:159] + "…"
    n = int(quote.get("files") or 0)
    files = f" [{n} file{'' if n == 1 else 's'}]" if n > 0 else ""
    return f"↩ re #{quote['seq']} @{quote['from']}: {text or '(no text)'}{files}"


READ_TEXT_CHARS = 3000
READ_BUDGET_CHARS = 30_000


def _utc(ms: int) -> str:
    return time.strftime("%Y-%m-%d %H:%MZ", time.gmtime(ms / 1000))


def _where(message: dict, conversations: dict) -> str:
    conversation = conversations.get(message["conversationId"])
    if not conversation:
        return message["conversationId"]
    return "@all" if conversation["kind"] == "all" else _format_address(conversation["members"])


def provenance_mark(verified: bool | None) -> str:
    """Same text as provenanceMark in packages/protocol/src/address.ts."""
    if verified is None:
        return ""
    return " (verified)" if verified else " (NOT verified: anyone on the LAN could have written this)"


def format_read_message(message: dict, conversations: dict, max_text: int, saved: list[str] | None = None) -> str:
    """Same text as formatReadMessage in packages/client/src/tool.ts (not a delivery header, on purpose)."""
    mark = provenance_mark(message.get("verified"))
    lines = [f"#{message['seq']} @{message['from']}{mark} → {_where(message, conversations)} · {_utc(message['createdAt'])}"]
    if message.get("quote"):
        lines.append(quote_line(message["quote"]))
    text = message.get("text") or ""
    if text:
        lines.append(text if len(text) <= max_text else
                     f"{text[:max_text]}… ({len(text)} chars; op=show message_id {message['seq']} for all)")
    for i, f in enumerate(message.get("files") or []):
        lines.append(f"File: {saved[i] if saved and i < len(saved) else f['name']} ({f['name']}, {f['size']} B)")
    return "\n".join(lines)


def format_search_hit(message: dict, conversations: dict, query: str) -> str:
    """Same text as formatSearchHit in packages/omp-extension/src/index.ts."""
    flat = " ".join((message.get("text") or "").split())
    at = flat.lower().find(query.lower()) if query else 0
    start = max(0, at - 80)
    snippet = ("…" if start > 0 else "") + flat[start:start + 200] + ("…" if start + 200 < len(flat) else "")
    files = f" [{', '.join(f['name'] for f in message['files'])}]" if message.get("files") else ""
    return (f"#{message['seq']} · {_utc(message['createdAt'])} · @{message['from']} → {_where(message, conversations)}: "
            f"{snippet or '(no text)'}{files}")


def within_budget(entries: list[str], separator: str) -> tuple[str, int]:
    """Joins entries newest-last within the budget, dropping the oldest first."""
    kept: list[str] = []
    size = 0
    for entry in reversed(entries):
        if kept and size + len(entry) > READ_BUDGET_CHARS:
            break
        kept.insert(0, entry)
        size += len(entry) + len(separator)
    return separator.join(kept), len(entries) - len(kept)


def describe_receipts(receipts: list[dict]) -> str:
    """Same text as describeReceipts in packages/protocol/src/address.ts."""
    if not receipts:
        return "no agent recipients (humans read it on the website)"
    def ids(pred: Any) -> str:
        return ", ".join(f"@{r['to']}" for r in receipts if pred(r))

    seen = ids(lambda r: r.get("seenAt") is not None)
    delivered = ids(lambda r: r.get("seenAt") is None and r.get("deliveredAt") is not None)
    pending = ids(lambda r: r.get("deliveredAt") is None)
    parts = [
        seen and f"seen by {seen}",
        delivered and f"delivered to {delivered} (not seen yet)",
        pending and f"not delivered yet (offline or reconnecting): {pending}",
    ]
    return "; ".join(p for p in parts if p)


def format_delivery(frame: dict, saved_files: list[str]) -> str:
    """Same text the omp extension injects (packages/omp-extension/src/index.ts formatDelivery)."""
    message, conversation = frame["message"], frame["conversation"]
    where = "@all" if conversation["kind"] == "all" else _format_address(conversation["addressed"])
    # Header format shared with deliveryHeader in packages/protocol/src/address.ts; pre_llm_call finds it again.
    sent = time.strftime("%Y-%m-%d %H:%MZ", time.gmtime(message["createdAt"] / 1000))
    lines = [f"[message-bus] #{message['seq']} @{message['from']}{provenance_mark(message.get('verified'))} → {where} · {sent}"]
    if message.get("quote"):
        lines.append(quote_line(message["quote"]))
    if message.get("text"):
        lines.append(message["text"])
    for i, f in enumerate(message.get("files") or []):
        local = saved_files[i] if i < len(saved_files) else f["name"]
        lines.append(f"File: {local} ({f['name']}, {f['size']} B, sha256 {f['sha256'][:12]}…)")
    lines.append(f"(Reply only if they need something from you: {TOOL_NAME} reply, message_id {message['seq']} → {frame['replyTo']}.)")
    return "\n".join(lines)


HEADER_SEQ = re.compile(r"\[message-bus\] #(\d+) @")


class BusClient:
    def __init__(self, url: str, name: str):
        self.url = url.rstrip("/")
        self.name = name

    def my_id(self) -> str:
        try:
            return ID_FILE.read_text().strip() or self.name
        except OSError:
            return self.name

    def _request(self, method: str, path: str, body: bytes | None = None, content_type: str = "application/json") -> dict:
        req = urllib.request.Request(f"{self.url}{path}", data=body, method=method,
                                     headers={"Content-Type": content_type} if body is not None else {})
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as err:
            try:
                detail = json.loads(err.read()).get("error")
            except Exception:
                detail = None
            raise RuntimeError(detail or f"HTTP {err.code} from {path}") from None
        except urllib.error.URLError as err:
            raise RuntimeError(f"message bus at {self.url} unreachable: {err.reason}") from None

    def write(self, target: dict, text: str, file_ids: list[str] | None = None) -> dict:
        """`target` is {"to": "@x"} or {"replyToSeq": n} (answer message n in its conversation)."""
        body = {"from": self.my_id(), **target, "text": text}
        if file_ids:
            body["fileIds"] = file_ids
        return self._request("POST", "/api/messages", json.dumps(body).encode())

    def upload(self, path: str) -> dict:
        p = Path(path).expanduser()
        if not p.is_file():
            raise RuntimeError(f"File not found: {path}")
        qs = urllib.parse.urlencode({"from": self.my_id(), "name": p.name})
        mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        return self._request("POST", f"/api/files?{qs}", p.read_bytes(), mime)["file"]

    def set(self, key: str, value: str) -> dict:
        body = {"from": self.my_id(), "key": key, "value": value}
        return self._request("POST", "/api/settings", json.dumps(body).encode())

    def get(self, path: str, params: dict) -> dict:
        """GET a reading endpoint (no turns for anyone); None values are left out."""
        qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        return self._request("GET", f"{path}?{qs}")

    def delivery_status(self, sent: dict) -> str:
        """Waits for receipts of a just-written message; remembers late group recipients."""
        seq = sent["message"]["seq"]
        message = self._request("GET", f"/api/messages/{seq}?waitMs={RECEIPT_WAIT_MS}&until=seen")["message"]
        pending = {r["to"] for r in message["receipts"] if r.get("deliveredAt") is None}
        late = bool(pending) and sent["conversation"]["kind"] == "group"
        if late:
            with _awaiting_lock:
                _awaiting_receipts[seq] = pending
        return describe_receipts(message["receipts"]) + (". You will be told when they receive it" if late else "")

    def download(self, ref: dict, dest_dir: Path) -> str:
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{ref['id']}-{ref['name'].replace('/', '_')}"
        with urllib.request.urlopen(f"{self.url}/api/files/{urllib.parse.quote(ref['id'])}", timeout=300) as res:
            dest.write_bytes(res.read())
        return str(dest)


class GatewayBridge:
    """Agent connection living in the gateway process; injects deliveries into `session_key`.

    Hermes runs every injected message as its own turn and, while the session is busy, queues them (at most
    32, then drops new ones). So at most one injection is outstanding: wake deliveries arriving while the
    previous injection has not reached the model yet are held here, unacked, and injected together as one
    message once it has (or after HOLD_MAX_S). Unacked held messages are re-sent by the server on reconnect.
    """

    def __init__(self, ctx: Any, client: BusClient, session_key: str):
        self.ctx = ctx
        self.client = client
        self.session_key = session_key
        self.quiet: list[str] = []
        self.quiet_lock = threading.Lock()
        # Delivered seqs not handed to the model yet, and the loop/socket to report them on.
        self.unseen: set[int] = set()
        self.unseen_lock = threading.Lock()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.ws: Any = None
        # Batching state (see class docstring).
        self.batch_lock = threading.Lock()
        self.held: dict[int, str] = {}
        self.outstanding: set[int] = set()
        self.outstanding_at = 0.0

    def start(self) -> None:
        threading.Thread(target=self._run, name="message-bus", daemon=True).start()

    def _gateway_live(self) -> bool:
        manager = getattr(self.ctx, "_manager", None)
        return bool(getattr(manager, "has_gateway_message_injector", False))

    def _run(self) -> None:
        # Plugins load in every Hermes process; only the live gateway publishes an injector.
        # Give up quietly after a minute in processes that never become a gateway (CLI, cron workers).
        deadline = time.monotonic() + 60
        while not self._gateway_live():
            if time.monotonic() > deadline:
                return
            time.sleep(1)
        asyncio.run(self._connect_forever())

    async def _connect_forever(self) -> None:
        import websockets  # in the Hermes runtime environment

        ws_base = self.client.url.replace("http", "ws", 1)
        qs = urllib.parse.urlencode({"host": socket.gethostname(), "harness": "hermes", "name": self.client.name})
        delay = 1.0
        asyncio.get_running_loop().create_task(self._watchdog())
        while True:
            try:
                async with websockets.connect(f"{ws_base}/ws/agent?{qs}", max_size=None) as ws:
                    delay = 1.0
                    self.loop, self.ws = asyncio.get_running_loop(), ws
                    async for raw in ws:
                        await self._handle(ws, json.loads(raw))
            except Exception as err:  # reconnect on any transport failure
                logger.warning("message-bus connection lost: %s (retrying in %.0fs)", err, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_S)

    async def _watchdog(self) -> None:
        """Injects held messages anyway when the outstanding injection has not been seen for HOLD_MAX_S."""
        while True:
            await asyncio.sleep(60)
            with self.batch_lock:
                stale = bool(self.held) and time.monotonic() - self.outstanding_at > HOLD_MAX_S
            if stale:
                await self._flush()

    async def _handle(self, ws: Any, frame: dict) -> None:
        kind = frame.get("type")
        if kind == "joined":
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            ID_FILE.write_text(frame["id"])
            logger.info("message-bus: joined as @%s", frame["id"])
        elif kind == "deliver":
            await self._deliver(ws, frame)
        elif kind == "receipt":
            self._receipt(frame)
        elif kind == "error":
            logger.warning("message-bus server error: %s", frame.get("error"))

    def _receipt(self, frame: dict) -> None:
        with _awaiting_lock:
            pending = _awaiting_receipts.get(frame["seq"])
            if not pending or frame["to"] not in pending:
                return
            pending.discard(frame["to"])
            if not pending:
                del _awaiting_receipts[frame["seq"]]
        with self.quiet_lock:
            self.quiet.append(f"[message-bus] @{frame['to']} has now received your message #{frame['seq']} "
                              f"(conversation {frame['conversationId']}).")

    async def _deliver(self, ws: Any, frame: dict) -> None:
        files = frame["message"].get("files") or []
        dest = STATE_DIR / "received" / self.client.my_id()
        saved = [await asyncio.to_thread(self.client.download, f, dest) for f in files]
        text = format_delivery(frame, saved)
        seq = frame["message"]["seq"]
        if not frame.get("wake"):
            with self.unseen_lock:
                self.unseen.add(seq)
            with self.quiet_lock:
                self.quiet.append(text)
            await ws.send(json.dumps({"type": "ack", "seq": seq}))
            return
        with self.batch_lock:
            if seq in self.held or seq in self.outstanding:
                return  # re-sent after a reconnect while still held or in flight
            self.held[seq] = text
            ready = not self.outstanding or time.monotonic() - self.outstanding_at > HOLD_MAX_S
        if ready:
            await self._flush()

    async def _flush(self) -> None:
        """Injects everything held as one message, then acks it."""
        with self.batch_lock:
            batch = sorted(self.held.items())
            self.held.clear()
            if not batch:
                return
            self.outstanding = {seq for seq, _ in batch}
            self.outstanding_at = time.monotonic()
        seqs = [seq for seq, _ in batch]
        with self.unseen_lock:
            self.unseen.update(seqs)
        texts = [text for _, text in batch]
        text = texts[0] if len(texts) == 1 else (
            f"[message-bus] {len(texts)} messages arrived while you were busy (oldest first):\n\n" + "\n\n".join(texts)
        )
        # Not acked until the gateway accepts it; while it refuses (restart/drain), retry.
        while not self.ctx.inject_message(text, session_key=self.session_key):
            logger.warning("message-bus: gateway did not accept seq %s; retrying", seqs)
            await asyncio.sleep(5)
        ws = self.ws
        if ws is not None:
            for seq in seqs:
                await ws.send(json.dumps({"type": "ack", "seq": seq}))

    def _session_id(self) -> str | None:
        try:
            index = json.loads((Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / "sessions" / "sessions.json").read_text())
            return (index.get(self.session_key) or {}).get("session_id")
        except (OSError, ValueError):
            return None

    def _report_seen(self, text: str) -> None:
        """Sends `seen` for every unseen delivery whose header appears in `text` (called from agent threads)."""
        with self.unseen_lock:
            seqs = [s for s in map(int, HEADER_SEQ.findall(text)) if s in self.unseen]
            self.unseen.difference_update(seqs)
        loop, ws = self.loop, self.ws
        if not seqs or loop is None or ws is None:
            return
        for seq in seqs:
            asyncio.run_coroutine_threadsafe(ws.send(json.dumps({"type": "seen", "seq": seq})), loop)
        with self.batch_lock:
            released = bool(self.outstanding.intersection(seqs))
            if released:
                self.outstanding.clear()
            flush = released and bool(self.held)
        if flush:
            asyncio.run_coroutine_threadsafe(self._flush(), loop)

    def pre_llm_call(self, session_id: str = "", user_message: Any = None, **_: Any) -> dict | None:
        """Reports deliveries in this turn's user message as seen; quiet ones ride along with the bus session's next turn."""
        if self.unseen:
            self._report_seen(json.dumps(user_message, default=str))
        if not self.quiet or session_id != self._session_id():
            return None
        with self.quiet_lock:
            pending, self.quiet = self.quiet, []
        context = "\n\n".join(pending)
        self._report_seen(context)
        return {"context": context}


def register(ctx: Any) -> None:
    url = str(ctx.get_config("url", "http://127.0.0.1:7800"))
    name = str(ctx.get_config("name", socket.gethostname()))
    session_key = ctx.get_config("session_key")
    client = BusClient(url, name)

    def handle(args: dict, **_: Any) -> str:
        # Arguments outside the schema used to be ignored, which stored empty messages (`content` for `message`).
        unknown = [k for k in args if k not in SCHEMA["parameters"]["properties"]]
        if unknown:
            raise ValueError(f"Unknown argument{'s' if len(unknown) > 1 else ''} {', '.join(unknown)}; the arguments are "
                             f"{', '.join(SCHEMA['parameters']['properties'])}. Nothing was sent.")
        op = args.get("op")

        def contents(res: dict) -> str:
            text, files = res["message"]["text"], res["message"]["files"]
            out = f"text {len(text)} chars" if text else "no text"
            if files:
                out += f", {len(files)} file{'' if len(files) == 1 else 's'}: {', '.join(f['name'] for f in files)}"
            return out

        def sent(what: str, res: dict) -> str:
            return (f"{what} (conversation {res['conversation']['id']}, message #{res['message']['seq']}): "
                    f"{contents(res)}; {client.delivery_status(res)}. (you are @{client.my_id()})")

        if op == "reply":
            if args.get("message_id") is None or not (args.get("message") or args.get("files")):
                raise ValueError("reply needs `message_id` and `message` (or `files`).")
            refs = [client.upload(p) for p in args.get("files") or []]
            res = client.write({"replyToSeq": int(args["message_id"])}, args.get("message") or "", [r["id"] for r in refs])
            return sent(f"Replied to #{args['message_id']}", res)
        if op in ("write", "send"):
            if not args.get("to") or not (args.get("files") if op == "send" else args.get("message") or args.get("files")):
                raise ValueError("send needs `to` and `files`." if op == "send" else "write needs `to` and `message` (or `files`).")
            refs = [client.upload(p) for p in args.get("files") or []]
            res = client.write({"to": args["to"]}, args.get("message") or "", [r["id"] for r in refs])
            return sent(f"Sent to {args['to']}", res)
        if op == "set":
            if not args.get("key") or args.get("value") is None:
                raise ValueError("set needs `key` and `value`.")
            res = client.set(args["key"], args["value"])
            return f"Settings now: {json.dumps(res['participant']['settings'])}. (you are @{client.my_id()})"
        me = client.my_id()
        scope = "all" if args.get("scope") == "all" else "mine"
        limit = int(args.get("limit") or 20)

        def listed(res: dict, what: str) -> str:
            by_id = {c["id"]: c for c in res["conversations"]}
            text, dropped = within_budget([format_read_message(m, by_id, READ_TEXT_CHARS) for m in res["messages"]], "\n\n")
            more = f" ({dropped} older ones left out; use a smaller limit)" if dropped else ""
            return f"{len(res['messages'])} {what}{more}:\n\n{text}\n (you are @{me})"

        if op == "inbox":
            res = client.get("/api/inbox", {"for": me, "sinceSeq": args.get("since") or 0, "limit": limit})
            if not res["messages"]:
                return f"No messages for you{' after #' + str(args['since']) if args.get('since') else ''}. (you are @{me})"
            return listed(res, "messages sent to you")
        if op == "show":
            if args.get("message_id") is None:
                raise ValueError("show needs `message_id`.")
            res = client.get(f"/api/messages/{int(args['message_id'])}", {})
            message, conversation = res["message"], res["conversation"]
            if scope != "all" and conversation["kind"] == "group" and me not in conversation["members"]:
                raise ValueError(f"#{message['seq']} is in a conversation you are not in "
                                 f"({_format_address(conversation['members'])}); add scope \"all\" to read it.")
            saved = [client.download(f, STATE_DIR / "received" / me) for f in message.get("files") or []]
            return f"{format_read_message(message, {conversation['id']: conversation}, 10 ** 9, saved)}\n (you are @{me})"
        if op == "history":
            params: dict = {"from": me, "limit": limit, "scope": scope}
            if args.get("to"):
                params["to"] = args["to"]
            elif args.get("message_id") is not None:
                params["conversationId"] = client.get(f"/api/messages/{int(args['message_id'])}", {})["message"]["conversationId"]
            else:
                raise ValueError("history needs `to` (an address) or `message_id` (that message's conversation).")
            res = client.get("/api/history", params)
            return listed(res, "messages, oldest first") if res["messages"] else f"No messages in that conversation yet. (you are @{me})"
        if op == "search":
            if not (args.get("query") or "").strip() and not args.get("sender"):
                raise ValueError("search needs `query` and/or `sender`.")
            res = client.get("/api/search", {"from": me, "q": args.get("query") or "", "sender": args.get("sender"),
                                              "limit": limit, "scope": scope})
            if not res["messages"]:
                return f"No matching messages. (you are @{me})"
            by_id = {c["id"]: c for c in res["conversations"]}
            text, dropped = within_budget([format_search_hit(m, by_id, args.get("query") or "") for m in res["messages"]], "\n")
            more = f" ({dropped} older ones left out)" if dropped else ""
            return f"{len(res['messages'])} matching messages, oldest first{more}:\n{text}\n (you are @{me})"
        raise ValueError("op must be reply, write, send, set, inbox, show, history or search.")

    ctx.register_tool(name=TOOL_NAME, toolset="message_bus", schema=SCHEMA, handler=handle,
                      description=SCHEMA["description"], emoji="📨")

    if not session_key:
        logger.warning("message-bus: plugins.entries.message-bus.settings.session_key is not set; not joining the bus")
        return
    bridge = GatewayBridge(ctx, client, str(session_key))
    ctx.register_hook("pre_llm_call", bridge.pre_llm_call)
    bridge.start()
