"""tonyland-hub subscriber (protocol v1).

The pet only listens: connect to 127.0.0.1, say hello, then keep the JSON-lines stream open.
Port and token are re-read from %LOCALAPPDATA%\\tonyland on every attempt because the launcher
changes both when it restarts. Every failure is silent -- a missing hub simply means the pet
stays in its local idle mode.
"""

import json
import os
import pathlib
import socket
import threading
import time
import uuid

HUB_DIR = pathlib.Path(os.environ.get("LOCALAPPDATA") or pathlib.Path.home()) / "tonyland"
RECONNECT_S = 30.0
STALE_S = 90.0
CLIENT_VERSION = "0.2.0"


def _read_file(name):
    try:
        return (HUB_DIR / name).read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return ""


class HubClient:
    def __init__(self, log, client_id=None):
        self._log = log
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._sock = None
        self._client_id = client_id or str(uuid.uuid4())
        self._events = []
        self._last_msg = 0.0
        self._state = {"connected": False, "online": 0, "names": [], "in_game": False,
                       "server_ok": False, "persona": "", "last_announce": None}

    @property
    def client_id(self):
        return self._client_id

    def start(self):
        if self._thread:
            return
        self._thread = threading.Thread(target=self._run, name="tonyland-hub", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        sock = self._sock
        if sock:
            try:
                sock.close()
            except OSError:
                pass

    def status(self):
        with self._lock:
            state = dict(self._state)
            state["names"] = list(self._state["names"])
        state["online"] = int(state.get("online") or 0)
        return state

    def take_events(self):
        with self._lock:
            events, self._events = self._events, []
        return events

    # ---------- connection loop ----------
    def _run(self):
        while not self._stop.is_set():
            port, token = self._read_endpoint()
            if not port or not token:
                self._wait(RECONNECT_S)
                continue
            try:
                sock = socket.create_connection(("127.0.0.1", port), timeout=5)
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                sock.settimeout(1.0)
            except OSError:
                self._wait(RECONNECT_S)
                continue
            self._sock = sock
            try:
                self._session(sock, token)
            except OSError as exc:
                self._log(f"hub disconnected: {exc!r}")
            finally:
                self._sock = None
                try:
                    sock.close()
                except OSError:
                    pass
                with self._lock:
                    self._state["connected"] = False
                self._push("hub.disconnected", {})
            if not self._stop.is_set():
                self._wait(RECONNECT_S)

    def _wait(self, seconds):
        # Sleep in slices so quit is not delayed; still only one attempt per period.
        deadline = time.monotonic() + seconds
        while not self._stop.is_set():
            left = deadline - time.monotonic()
            if left <= 0:
                return
            time.sleep(min(0.5, left))

    def _read_endpoint(self):
        try:
            port = int(_read_file("hub.port"))
        except ValueError:
            port = 0
        token = _read_file("hub.token")
        if port <= 0 or port > 65535 or not token:
            return 0, ""
        return port, token

    def _session(self, sock, token):
        hello = {"v": 1, "type": "hello", "ts": int(time.time() * 1000),
                 "id": str(uuid.uuid4()),
                 "data": {"client": "pet", "version": CLIENT_VERSION,
                          "token": token, "client_id": self._client_id}}
        self._send(sock, hello)
        self._last_msg = time.monotonic()
        with self._lock:
            self._state["connected"] = True
        self._log("hub connected")
        self._push("hub.connected", {})

        buf = b""
        while not self._stop.is_set():
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                if time.monotonic() - self._last_msg > STALE_S:
                    self._log("hub silent for 90s, treating as offline")
                    return
                continue
            if not chunk:
                return
            buf += chunk
            if len(buf) > 1_000_000:  # malformed peer, drop the backlog
                buf = b""
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if line.strip():
                    self._on_line(sock, line)

    @staticmethod
    def _send(sock, msg):
        sock.sendall((json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8"))

    def _on_line(self, sock, line):
        try:
            msg = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        self._last_msg = time.monotonic()
        if msg.get("v") not in (None, 1):
            return
        kind = msg.get("type")
        data = msg.get("data")
        if not isinstance(data, dict):
            data = {}
        msg_id = msg.get("id")
        try:
            self._apply(kind, data)
            if kind and kind != "state.snapshot" and isinstance(msg_id, str):
                self._send(sock, {"v": 1, "type": "ack", "ts": int(time.time() * 1000),
                                  "id": str(uuid.uuid4()), "data": {"id": msg_id}})
        except OSError:
            raise
        except Exception as exc:  # noqa: BLE001 - unknown payloads must never kill the link
            self._log(f"hub message ignored: {exc!r}")

    def _apply(self, kind, data):
        if kind == "state.snapshot":
            with self._lock:
                self._state.update({
                    "in_game": bool(data.get("in_game")),
                    "online": int(data.get("online") or 0),
                    "names": [str(n) for n in data.get("online_names") or []],
                    "server_ok": bool(data.get("server_ok")),
                    "persona": str(data.get("persona") or ""),
                    "pack_version": str(data.get("pack_version") or ""),
                    "smartcore_version": str(data.get("smartcore_version") or ""),
                    "last_announce": data.get("last_announce") if isinstance(data.get("last_announce"), dict) else None,
                })
        elif kind == "event.presence":
            with self._lock:
                self._state["online"] = int(data.get("online") or 0)
                self._state["names"] = [str(n) for n in data.get("names") or []]
            self._push("presence", {"online": self._state["online"], "names": list(self._state["names"])})
        elif kind == "event.game":
            self._push("game", {"kind": str(data.get("kind") or ""),
                                "player": str(data.get("player") or ""),
                                "detail": str(data.get("detail") or "")})
        elif kind == "event.announce":
            announce = {"title": str(data.get("title") or ""),
                        "body": str(data.get("body") or ""),
                        "level": str(data.get("level") or "info")}
            with self._lock:
                self._state["last_announce"] = dict(announce)
            self._push("announce", announce)
        elif kind == "event.mood":
            self._push("mood", {"mood": str(data.get("mood") or ""),
                                "ttl_ms": int(data.get("ttl_ms") or 8000)})
        elif kind == "event.config":
            with self._lock:
                self._state["pack_version"] = str(data.get("pack_version") or self._state.get("pack_version") or "")
                self._state["smartcore_version"] = str(data.get("smartcore_version") or self._state.get("smartcore_version") or "")
            self._push("config", {"pack_version": data.get("pack_version"),
                                  "smartcore_version": data.get("smartcore_version"),
                                  "pet_assets_version": data.get("pet_assets_version")})
        # anything else: forward-compatible ignore

    def _push(self, kind, payload):
        with self._lock:
            if len(self._events) >= 32:
                return
            self._events.append({"type": kind, "data": payload})
