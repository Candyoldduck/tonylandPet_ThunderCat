"""雷霆喵桌宠 —— pywebview + WinForms 透明窗口外壳。

页面在 WebView2 中渲染实时网格模型；窗口用洋红色键（TransparencyKey）做真正透明。
键色窗口整块都是鼠标穿透的，所以猫咪身上的点击、拖动、滚轮由全局鼠标钩子接管，
再通过 api.poll() 转发给页面（菜单和缩放都在页面里实现）。
"""

import ctypes
import ctypes.wintypes as wt
import json
import math
import os
import pathlib
import random
import sys
import threading
import time
import uuid

import webview

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from hub_client import HubClient  # noqa: E402
from local_server import start as start_server  # noqa: E402

# The page's file tree (pet.html, desktop-pet/, src/engine/, projects/leitingmiao/) is served
# straight off this root.  A frozen build stages the same tree under web/ next to the executable,
# so the layout the browser sees stays identical either way.
ROOT = (pathlib.Path(sys.executable).parent / "web") if getattr(sys, "frozen", False) \
    else pathlib.Path(__file__).resolve().parent.parent
APP_DIR = pathlib.Path(os.environ.get("APPDATA") or pathlib.Path.home()) / "LeitingMiao"
SETTINGS_FILE = APP_DIR / "settings.json"
LOG_FILE = APP_DIR / "pet.log"
TITLE = "雷霆喵"
if os.environ.get("PET_DEBUG") == "1":
    webview.settings["REMOTE_DEBUGGING_PORT"] = 9334
DEFAULT_W, DEFAULT_H = 320, 490

# Release physics. Everything here is in CSS px (the page's units) and scaled by the window's
# DPI factor when the real window is moved; the speeds handed to the animation stay in CSS px.
GRAVITY = 2350.0      # px/s² while nothing supports the pet
AIR_DRAG = 1.1        # 1/s, horizontal slowdown in flight
ROLL_DRAG = 7.0       # 1/s, friction once it stands on the floor
FLOOR_REST = 0.36     # share of the landing speed kept as a bounce
WALL_REST = 0.34      # ...and the share kept when it hits a screen edge
CEIL_REST = 0.25
FLOOR_MARGIN = 12     # px above the work area: the line the pet starts and stands on
SETTLE_VY = 95.0      # px/s: a floor contact slower than this does not bounce
SETTLE_VX = 14.0      # px/s: sliding slower than this counts as standing still
FLING_LIMIT = 8.0     # s, safety net so a pathological bounce chain still ends

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
user32.FindWindowW.restype = wt.HWND
user32.GetWindowLongW.restype = ctypes.c_long
user32.SetWindowLongW.restype = ctypes.c_long
user32.GetCursorPos.argtypes = [ctypes.POINTER(wt.POINT)]
user32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
user32.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
try:
    user32.GetDpiForWindow.restype = ctypes.c_uint
except AttributeError:  # pragma: no cover - very old Windows
    user32.GetDpiForWindow = None

SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
WS_EX_TOPMOST = 0x00000008

LRESULT = ctypes.c_ssize_t
WH_MOUSE_LL = 14
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_RBUTTONDOWN = 0x0204
WM_RBUTTONUP = 0x0205
WM_MOUSEWHEEL = 0x020A


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("pt", wt.POINT), ("mouseData", wt.DWORD), ("flags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


HOOKPROC = ctypes.WINFUNCTYPE(LRESULT, ctypes.c_int, wt.WPARAM, wt.LPARAM)


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]


user32.MonitorFromWindow.restype = ctypes.c_void_p
user32.MonitorFromWindow.argtypes = [wt.HWND, wt.DWORD]
user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.POINTER(MONITORINFO)]


_DEBUG = os.environ.get("PET_DEBUG") == "1"


def write_log(text):
    try:
        APP_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%H:%M:%S')} {text}\n")
    except Exception:
        pass


def load_settings():
    defaults = {"x": None, "y": None, "w": DEFAULT_W, "h": DEFAULT_H,
                "topmost": True, "follow": True, "idle": True, "roam": True}
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            defaults.update({k: data[k] for k in defaults if k in data})
    except Exception:
        pass
    return defaults


def save_settings(data):
    try:
        APP_DIR.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:
        write_log(f"save settings failed: {exc!r}")


def work_area():
    rect = wt.RECT()
    user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0)  # SPI_GETWORKAREA
    return rect


def virtual_screen():
    """Bounds of all monitors, so a pet parked on a secondary display survives a restart."""
    g = user32.GetSystemMetrics
    x, y = g(76), g(77)
    return wt.RECT(x, y, x + g(78), y + g(79))


def monitor_work_area(hwnd):
    mon = user32.MonitorFromWindow(hwnd, 2)  # MONITOR_DEFAULTTONEAREST
    if mon:
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(mon, ctypes.byref(info)):
            return info.rcWork
    return work_area()


def fling_step(vx, vy, left, top, standing, dt, b, scale):
    """Advance one step of a released pet: momentum, gravity, edge and floor bounces.

    Pure arithmetic so the feel can be unit-tested without a window. `b` carries the screen in
    physical px as (work left, work top, work right, window width, floor top), and `standing`
    means the pet already rested on the floor line when the step began, so friction - not
    gravity - owns the horizontal speed. Returns (vx, vy, left, top, settled, impact, bump,
    bump_dir); impact is the downward speed of a floor contact hard enough to bounce, and bump
    the speed lost against an edge with bump_dir saying which way it was shoved (-1 left, 1
    right, 0 up), which the animation turns into a stagger instead of a crouch.
    """
    vx *= math.exp(-(ROLL_DRAG if standing else AIR_DRAG) * dt)
    if standing:
        vy = 0.0
    else:
        vy += GRAVITY * scale * dt
    left, top = left + vx * dt, top + vy * dt
    bump, bdir = 0.0, 0
    if left < b[0]:
        if vx < 0.0:
            bump, bdir, vx = -vx, -1, -vx * WALL_REST
        left = float(b[0])
    elif left > b[2] - b[3]:
        if vx > 0.0:
            bump, bdir, vx = vx, 1, -vx * WALL_REST
        left = float(b[2] - b[3])
    if top < b[1]:
        if vy < 0.0:
            if -vy > bump:
                bump, bdir = -vy, 0
            vy = max(0.0, -vy * CEIL_REST)
        top = float(b[1])
    settled = standing
    if vy > 0.0 and top >= b[4]:
        impact, top = vy, float(b[4])
        if impact < SETTLE_VY * scale:
            vy, settled, impact = 0.0, True, 0.0
        else:
            vy = -impact * FLOOR_REST
    elif top > b[4]:  # sunk past the floor line: climb back onto it
        top, vy, settled, impact = float(b[4]), 0.0, True, 0.0
    else:
        impact = 0.0
    return vx, vy, left, top, settled, impact, bump, bdir


class _InputHook:
    """Global low-level mouse listener.

    The layered colour-key window is transparent to mouse input everywhere, so pet hits are
    detected here (against a coarse alpha mask supplied by the page). Events are queued and
    handed to the page through Api.poll(); consumed events never reach the app behind the pet.
    """

    def __init__(self, api):
        self.api = api
        self._lock = threading.Lock()
        self._events = []
        self._mask = None          # (cols, rows, bytes)
        self._menu = None          # (l, t, r, b) in CSS px
        self._down = None
        self._rdown = False
        self._dragging = False
        self._grab = None          # cursor offset inside the window when the drag began
        self._drag_vel = (0.0, 0.0)  # cursor speed in CSS px/s, smoothed for the animation
        self._drag_thread = None
        self._thread = None
        self._hook = None
        self._callback = None

    @property
    def dragging(self):
        return self._dragging

    @property
    def drag_vel(self):
        return self._drag_vel

    def start(self):
        if self._thread:
            return
        self._thread = threading.Thread(target=self._run, name="pet-mouse", daemon=True)
        self._thread.start()

    def _run(self):
        try:
            kernel32.GetModuleHandleW.restype = ctypes.c_void_p
            kernel32.GetModuleHandleW.argtypes = [wt.LPCWSTR]
            user32.SetWindowsHookExW.restype = ctypes.c_void_p
            user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, ctypes.c_void_p, ctypes.c_uint]
            user32.CallNextHookEx.restype = LRESULT
            user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wt.WPARAM, wt.LPARAM]
            self._callback = HOOKPROC(self._proc)
            self._hook = user32.SetWindowsHookExW(
                WH_MOUSE_LL, self._callback, kernel32.GetModuleHandleW(None), 0)
            write_log(f"mouse hook: {'on' if self._hook else 'failed'}")
            if not self._hook:
                return
            msg = wt.MSG()
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        except Exception as exc:  # noqa: BLE001
            write_log(f"mouse hook error: {exc!r}")

    def _proc(self, code, wparam, lparam):
        if code == 0:
            try:
                if self._handle(wparam, lparam):
                    return 1
            except Exception as exc:  # noqa: BLE001 - a hook callback must never die
                write_log(f"hook callback error: {exc!r}")
        return user32.CallNextHookEx(None, code, wparam, lparam)

    def set_mask(self, cols, rows, bits):
        cols, rows = int(cols), int(rows)
        if cols <= 0 or rows <= 0 or len(bits) != cols * rows:
            return False
        self._mask = (cols, rows, bytes(1 if c == "1" else 0 for c in bits))
        write_log(f"hit mask {cols}x{rows}")
        return True

    def set_menu(self, rect):
        if not rect or len(rect) != 4:
            self._menu = None
            return True
        try:
            l, t, r, b = (float(v) for v in rect)
        except (TypeError, ValueError):
            return False
        self._menu = (min(l, r), min(t, b), max(l, r), max(t, b))
        return True

    def take_events(self):
        with self._lock:
            events, self._events = self._events, []
        return events

    def _queue(self, kind, **payload):
        with self._lock:
            if len(self._events) < 64:
                self._events.append({"type": kind, **payload})

    def _hit(self, x, y):
        api = self.api
        hwnd = api.hwnd
        if not hwnd or not user32.IsWindow(hwnd):
            return None
        r = wt.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return None
        if not (r.left <= x < r.right and r.top <= y < r.bottom):
            return None
        s = api._dpi_scale(wait=False) or 1.0
        css_w = max(1.0, (r.right - r.left) / s)
        css_h = max(1.0, (r.bottom - r.top) / s)
        cx, cy = (x - r.left) / s, (y - r.top) / s
        menu = self._menu
        if menu and menu[0] <= cx <= menu[2] and menu[1] <= cy <= menu[3]:
            return {"x": round(cx, 1), "y": round(cy, 1), "menu": True}
        mask = self._mask
        if mask:
            cols, rows, bits = mask
            col = min(cols - 1, max(0, int(cx / css_w * cols)))
            row = min(rows - 1, max(0, int(cy / css_h * rows)))
            if 0 <= cx < css_w and 0 <= cy < css_h and bits[row * cols + col]:
                return {"x": round(cx, 1), "y": round(cy, 1), "menu": False}
        return None

    def _start_drag(self):
        if self._drag_thread and self._drag_thread.is_alive():
            return
        self._drag_thread = threading.Thread(target=self._drag_loop, name="pet-drag", daemon=True)
        self._drag_thread.start()

    def _drag_loop(self):
        """Follow the cursor from a worker thread.

        Moving the window inside the WH_MOUSE_LL callback stalls the whole input queue
        (cursor freezes too), so the hook only tracks state and this loop does SetWindowPos.
        """
        hwnd = self.api.hwnd
        grab = self._grab
        if not hwnd or not grab:
            return
        scale = self.api._dpi_scale(wait=False) or 1.0
        pt = wt.POINT()
        last = None
        last_t = time.monotonic()
        vx = vy = 0.0
        try:
            while self._dragging and self._down:
                if not user32.GetCursorPos(ctypes.byref(pt)):
                    break
                left, top = pt.x - grab[0], pt.y - grab[1]
                r = wt.RECT()
                if user32.GetWindowRect(hwnd, ctypes.byref(r)):
                    # keep the whole figure inside the monitor: a release that starts outside the
                    # work area would otherwise snap inwards on its first step
                    w = monitor_work_area(hwnd)
                    left = max(w.left, min(left, max(w.left, w.right - (r.right - r.left))))
                    top = max(w.top, min(top, max(w.top, w.bottom - (r.bottom - r.top))))
                user32.SetWindowPos(hwnd, None, left, top, 0, 0,
                                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
                now = time.monotonic()
                if last is not None:
                    dt = max(0.001, now - last_t)
                    # cap and smooth: raw per-frame deltas are noisy at ~100 Hz
                    tvx = max(-3000.0, min(3000.0, (pt.x - last[0]) / dt / scale))
                    tvy = max(-3000.0, min(3000.0, (pt.y - last[1]) / dt / scale))
                    k = min(1.0, dt * 16.0)
                    vx += (tvx - vx) * k
                    vy += (tvy - vy) * k
                    self._drag_vel = (round(vx, 1), round(vy, 1))
                last = (pt.x, pt.y)
                last_t = now
                time.sleep(0.010)
        finally:
            self._drag_vel = (0.0, 0.0)

    def _handle(self, wparam, lparam):
        ms = ctypes.cast(lparam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
        x, y = int(ms.pt.x), int(ms.pt.y)
        if _DEBUG and wparam != WM_MOUSEMOVE:
            write_log(f"evt {wparam:#x} {x},{y}")

        if wparam == WM_MOUSEMOVE:
            # Never consume motion: a swallowed WM_MOUSEMOVE freezes the system cursor itself,
            # which is exactly what made the pet and the pointer stall together. The window is
            # moved by _drag_loop from the live cursor position instead.
            if not self._down:
                return False
            if self._down.get("menu"):
                return False  # pressing a menu button must not drag the window
            dx, dy = x - self._down["last"][0], y - self._down["last"][1]
            if dx or dy:
                self._down["last"] = (x, y)
                self._down["total"] += abs(dx) + abs(dy)
                if self._down["total"] > 3 and not self._dragging:
                    self._dragging = True
                    if _DEBUG:
                        write_log(f"drag start total={self._down['total']}")
                    self._start_drag()
            return False

        if wparam == WM_LBUTTONDOWN:
            spot = self._hit(x, y)
            if _DEBUG:
                write_log(f"lbtn down -> {'hit' if spot else 'miss'}")
            if not spot:
                if self._menu:
                    self._queue("closemenu")
                return False
            self.api._cancel_roam()
            self.api._cancel_fling()
            self._down = {"last": (x, y), "total": 0, "menu": spot["menu"],
                          "x": spot["x"], "y": spot["y"]}
            self._dragging = False
            r = wt.RECT()
            if user32.GetWindowRect(self.api.hwnd, ctypes.byref(r)):
                self._grab = (x - r.left, y - r.top)
            else:
                self._grab = None
            self._queue("down", x=spot["x"], y=spot["y"], menu=spot["menu"])
            return True

        if wparam == WM_LBUTTONUP:
            down = self._down
            if not down:
                return False
            self._down = None
            was_drag = self._dragging
            # read the speed before stopping the loop: its finally block zeroes it
            released = self._drag_vel if was_drag else (0.0, 0.0)
            self._dragging = False
            if _DEBUG:
                write_log(f"lbtn up drag={was_drag} total={down['total']} v={released}")
            if down["menu"]:
                self._queue("click", x=down["x"], y=down["y"], menu=True)
            elif was_drag or down["total"] > 4:
                self._queue("dragend")
                self.api.fling(*released)
            else:
                spot = self._hit(x, y) or down
                self._queue("click", x=spot["x"], y=spot["y"], menu=False)
            return True

        if wparam == WM_RBUTTONDOWN:
            spot = self._hit(x, y)
            if not spot:
                if self._menu:
                    self._queue("closemenu")
                return False
            self.api._cancel_roam()
            self._rdown = True
            return True

        if wparam == WM_RBUTTONUP:
            if not self._rdown:
                return False
            self._rdown = False
            spot = self._hit(x, y)
            if spot:
                self._queue("rclick", x=spot["x"], y=spot["y"], menu=spot["menu"])
                return True
            return False

        if wparam == WM_MOUSEWHEEL:
            spot = self._hit(x, y)
            if not spot:
                return False
            delta = (int(ms.mouseData) >> 16) & 0xFFFF
            if delta > 32767:
                delta -= 65536
            self._queue("wheel", x=spot["x"], y=spot["y"], delta=delta, menu=spot["menu"])
            return True

        return False


class Api:
    def __init__(self):
        self._window = None
        self.hwnd = None
        self.settings = load_settings()
        self.ready_once = False
        self._delegate = None
        self._hook = _InputHook(self)
        self._roam_stop = threading.Event()
        self.walking = False
        self._fling_stop = threading.Event()
        self._fling_thread = None
        self._flight = (0.0, 0.0)   # window speed handed to the animation, CSS px/s
        self.airborne = False       # nothing supports the pet: it is falling or bouncing
        self.flinging = False       # a release is still being integrated
        client_id = self.settings.get("client_id")
        if not isinstance(client_id, str) or len(client_id) < 8:
            client_id = str(uuid.uuid4())
            self.settings["client_id"] = client_id
            save_settings(self.settings)
        self.hub = HubClient(write_log, client_id)

    # ---------- window helpers ----------
    def _find_hwnd(self):
        if self.hwnd and user32.IsWindow(self.hwnd):
            return self.hwnd
        for _ in range(150):
            hwnd = user32.FindWindowW(None, TITLE)
            if hwnd:
                self.hwnd = hwnd
                return hwnd
            time.sleep(0.05)
        return None

    def _dpi_scale(self, wait=True):
        hwnd = self._find_hwnd() if wait else (
            self.hwnd if self.hwnd and user32.IsWindow(self.hwnd) else None)
        if not hwnd:
            try:
                return user32.GetDpiForSystem() / 96.0
            except Exception:
                return 1.0
        try:
            return user32.GetDpiForWindow(hwnd) / 96.0
        except Exception:
            return 1.0

    def _rect(self):
        hwnd = self._find_hwnd()
        if not hwnd:
            return None
        r = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        return r

    def _place(self, x, y, w_css, h_css):
        hwnd = self._find_hwnd()
        if not hwnd:
            return
        s = self._dpi_scale()
        user32.SetWindowPos(hwnd, None, int(x), int(y), int(w_css * s), int(h_css * s),
                            SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW)
        self.settings.update({"x": int(x), "y": int(y), "w": w_css, "h": h_css})

    def _default_xy(self, w_css, h_css):
        area = work_area()
        s = self._dpi_scale(wait=False)
        x = area.right - int(w_css * s) - int(24 * s)
        y = area.bottom - int(h_css * s) - int(12 * s)
        return x, y

    def apply_key(self):
        """Make the form transparent with a color key.

        Must run after the page finished loading: changing TransparencyKey recreates the
        WinForms handle and aborts an in-flight WebView2 initialization (E_ABORT). WebView2
        itself is created with a transparent background, so the page's transparent pixels
        show the form's keyed color and the desktop comes through.
        """
        try:
            import clr

            clr.AddReference("System.Drawing")
            from System import Action
            from System.Drawing import Color

            form = self._window.native
            done = threading.Event()

            def run():
                try:
                    form.BackColor = Color.Magenta
                    form.TransparencyKey = Color.Magenta
                    form.ShowInTaskbar = False
                    write_log("transparency key applied")
                except Exception as exc:  # noqa: BLE001
                    write_log(f"transparency key failed: {exc!r}")
                finally:
                    done.set()

            self._delegate = Action(run)
            form.BeginInvoke(self._delegate)
            done.wait(8)
        except Exception as exc:  # noqa: BLE001
            write_log(f"key setup error: {exc!r}")

    # ---------- called from JS ----------
    def log(self, message):
        write_log(str(message))
        return True

    def ready(self, info):
        if self.ready_once:
            return {"w": self.settings["w"], "h": self.settings["h"]}
        self.ready_once = True
        self.apply_key()
        hwnd = self._find_hwnd()
        if not hwnd:
            write_log("ready: window handle not found")
            return {"w": self.settings["w"], "h": self.settings["h"]}

        # tool window: no alt-tab entry
        ex = user32.GetWindowLongW(hwnd, -20)
        user32.SetWindowLongW(hwnd, -20, ex | 0x00000080)

        s = self._dpi_scale()
        w_css = int(self.settings.get("w") or DEFAULT_W)
        h_css = int(self.settings.get("h") or DEFAULT_H)
        x = self.settings.get("x")
        y = self.settings.get("y")
        if x is None or y is None:
            x, y = self._default_xy(w_css, h_css)
        else:
            area = virtual_screen()
            x = max(area.left, min(int(x), area.right - int(w_css * s)))
            y = max(area.top, min(int(y), area.bottom - int(h_css * s)))
        self._place(x, y, w_css, h_css)
        self.set_topmost(bool(self.settings.get("topmost", True)))
        self._settle_topmost()
        self._hook.start()
        self.hub.start()
        write_log(f"ready: {w_css}x{h_css} at {x},{y} dpi={s:.2f}")
        return {"w": w_css, "h": h_css, "follow": bool(self.settings.get("follow", True)),
                "idle": bool(self.settings.get("idle", True)),
                "roam": bool(self.settings.get("roam", True)),
                "topmost": bool(self.settings.get("topmost", True))}

    def cursor(self):
        hwnd = self._find_hwnd()
        if not hwnd:
            return None
        p = wt.POINT()
        if not user32.GetCursorPos(ctypes.byref(p)):
            return None
        r = self._rect()
        if not r:
            return None
        s = self._dpi_scale()
        return {"x": (p.x - r.left) / s, "y": (p.y - r.top) / s}

    def poll(self):
        """Cursor + queued native mouse events; called by the page ~20 times a second."""
        self._keep_topmost()
        return {"cursor": self.cursor(), "events": self._hook.take_events(),
                "walking": bool(self.walking), "dragging": bool(self._hook.dragging),
                "drag_vel": list(self._hook.drag_vel),
                "flight": list(self._flight), "airborne": bool(self.airborne),
                "flinging": bool(self.flinging),
                "hub": self.hub.status(), "hub_events": self.hub.take_events()}

    def _keep_topmost(self):
        """Re-apply the topmost style if the live window stopped matching the setting.

        The colour-key work recreates the WinForms handle, and a fresh handle can arrive after
        ready() and the settle window have both finished styling the old one - the pet then sinks
        behind the desktop with nothing left to bring it back.
        """
        hwnd = self.hwnd
        if not hwnd or not user32.IsWindow(hwnd):
            return
        want = bool(self.settings.get("topmost", True))
        if bool(user32.GetWindowLongW(hwnd, -20) & WS_EX_TOPMOST) != want:
            self.set_topmost(want)

    def set_mask(self, cols, rows, bits):
        return self._hook.set_mask(cols, rows, bits)

    def set_menu_rect(self, rect):
        return self._hook.set_menu(rect)

    def roam(self):
        """Walk horizontally to a random spot on the current monitor."""
        if self.walking or self.airborne:
            return False
        hwnd = self._find_hwnd()
        r = self._rect()
        if not hwnd or not r:
            return False
        work = monitor_work_area(hwnd)
        s = self._dpi_scale(wait=False) or 1.0
        span = int(210 * s)
        target = r.left + random.randint(-span, span)
        target = max(work.left + 4, min(target, work.right - (r.right - r.left) - 4))
        if abs(target - r.left) < int(30 * s):
            return False
        self.walking = True
        self._roam_stop.clear()
        write_log(f"walk {r.left} -> {target}")
        threading.Thread(target=self._walk_loop, args=(r.left, target, r.top), daemon=True).start()
        return True

    def stop_roam(self):
        self._cancel_roam()
        return True

    def _cancel_roam(self):
        self._roam_stop.set()
        self.walking = False

    def _walk_loop(self, start, target, top):
        hwnd = self.hwnd
        speed = 150.0 * (self._dpi_scale(wait=False) or 1.0)
        dur = max(0.35, abs(target - start) / speed)
        t0 = time.monotonic()
        try:
            while not self._roam_stop.is_set():
                p = min(1.0, (time.monotonic() - t0) / dur)
                ease = p * p * (3 - 2 * p)
                left = int(round(start + (target - start) * ease))
                user32.SetWindowPos(hwnd, None, left, top, 0, 0,
                                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
                if p >= 1:
                    break
                time.sleep(0.016)
        finally:
            self.walking = False
            write_log("walk done")
            r = self._rect()
            if r:
                self.settings.update({"x": r.left, "y": r.top})
                save_settings(self.settings)

    def fling(self, vx_css, vy_css):
        """Momentum after a release: the window keeps travelling, falls, and bounces.

        Letting go is not the same as landing. Whatever speed the hand had at that moment
        becomes the window's own speed, gravity takes over as soon as the pet hangs above the
        floor line, and each floor contact keeps a shrinking share of the speed as a bounce.
        The speed is handed to the page so the pose, hair and skirt follow along.
        """
        if self._fling_thread and self._fling_thread.is_alive():
            return False
        hwnd = self._find_hwnd()
        if not hwnd:
            return False
        self._cancel_roam()
        s = self._dpi_scale(wait=False) or 1.0
        self._fling_stop.clear()
        self._fling_thread = threading.Thread(target=self._fling_loop,
                                              args=(float(vx_css) * s, float(vy_css) * s),
                                              name="pet-fling", daemon=True)
        self._fling_thread.start()
        return True

    def _cancel_fling(self):
        self._fling_stop.set()
        self.airborne = False
        self.flinging = False
        self._flight = (0.0, 0.0)

    def _fling_loop(self, vx, vy):
        """Integrate the release at ~80 Hz from a worker thread (same reason as _drag_loop)."""
        hwnd = self.hwnd
        s = self._dpi_scale(wait=False) or 1.0
        work = monitor_work_area(hwnd)
        settle_x = SETTLE_VX * s
        floor_gap = int(FLOOR_MARGIN * s)
        self.airborne = True
        self.flinging = True
        t0 = last = time.monotonic()
        try:
            while not self._fling_stop.is_set():
                now = time.monotonic()
                dt = min(0.033, max(0.001, now - last))
                last = now
                r = self._rect()
                if not r:
                    break
                w, h = r.right - r.left, r.bottom - r.top
                floor = work.bottom - h - floor_gap
                standing = r.top >= floor and vy >= 0.0
                vx, vy, left, top, settled, impact, bump, bdir = fling_step(
                    vx, vy, r.left, r.top, standing, dt,
                    (work.left, work.top, work.right, w, floor), s)
                if impact:
                    self._hook._queue("land", v=round(min(1.0, impact / (1500.0 * s)), 3))
                    write_log(f"land {round(impact / s)}")
                elif bump:
                    # a screen edge is not the floor: it is shoved sideways and staggers instead
                    self._hook._queue("bump", v=round(min(1.0, bump / (1500.0 * s)), 3), dir=bdir)
                    write_log(f"bump {round(bump / s)} {bdir}")
                self.airborne = not settled
                self._flight = (round(vx / s, 1), round(vy / s, 1))
                user32.SetWindowPos(hwnd, None, int(round(left)), int(round(top)), 0, 0,
                                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW)
                if settled and abs(vx) < settle_x:
                    break
                if now - t0 > FLING_LIMIT:
                    break
                time.sleep(0.012)
        finally:
            self._flight = (0.0, 0.0)
            self.airborne = False
            self.flinging = False
            r = self._rect()
            if r:
                self.settings.update({"x": r.left, "y": r.top})
                save_settings(self.settings)

    def move_by(self, dx, dy):
        hwnd = self._find_hwnd()
        r = self._rect()
        if not hwnd or not r:
            return False
        s = self._dpi_scale()
        work = monitor_work_area(hwnd)
        w, h = r.right - r.left, r.bottom - r.top
        left = max(work.left, min(r.left + int(round(dx * s)), work.right - w))
        top = max(work.top, min(r.top + int(round(dy * s)), work.bottom - h))
        # SWP_NOZORDER: without it the move re-inserts the window as a plain top window and
        # silently drops WS_EX_TOPMOST, so the pet ends up behind the desktop after a bounce.
        user32.SetWindowPos(hwnd, None, left, top, 0, 0,
                            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW)
        return True

    def set_size(self, w_css, h_css):
        w_css = max(180, min(560, int(w_css)))
        h_css = max(276, min(858, int(h_css)))
        r = self._rect()
        s = self._dpi_scale()
        if not r:
            return False
        pw, ph = int(w_css * s), int(h_css * s)
        left = r.left + (r.right - r.left - pw) // 2  # grow/shrink around the feet
        top = r.bottom - ph
        work = monitor_work_area(self.hwnd)
        left = max(work.left, min(left, work.right - pw))
        top = max(work.top, min(top, work.bottom - ph))
        self._place(left, top, w_css, h_css)
        save_settings(self.settings)
        return True

    def set_topmost(self, on):
        hwnd = self._find_hwnd()
        if not hwnd:
            return False
        user32.SetWindowPos(hwnd, HWND_TOPMOST if on else HWND_NOTOPMOST, 0, 0, 0, 0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
        if _DEBUG:
            ex = user32.GetWindowLongW(hwnd, -20)
            write_log(f"set_topmost({on}) hwnd={hwnd} ex={ex:#x}")
        self.settings["topmost"] = bool(on)
        save_settings(self.settings)
        return True

    def _settle_topmost(self):
        """Re-apply the topmost style every time the window handle changes for a few seconds.

        Assigning TransparencyKey/ShowInTaskbar recreates the WinForms handle, and the fresh
        handle arrives a beat after ready() has styled the old one, so the first SetWindowPos
        lands on a window that is about to be thrown away and the pet sinks behind the desktop.
        """
        def watch():
            deadline, seen = time.monotonic() + 6.0, None
            while time.monotonic() < deadline:
                hwnd = self._find_hwnd()
                if hwnd and hwnd != seen:
                    seen = hwnd
                    self.set_topmost(bool(self.settings.get("topmost", True)))
                time.sleep(0.1)

        threading.Thread(target=watch, daemon=True).start()

    def reset_position(self):
        self._cancel_fling()
        w_css = int(self.settings.get("w") or DEFAULT_W)
        h_css = int(self.settings.get("h") or DEFAULT_H)
        x, y = self._default_xy(w_css, h_css)
        self._place(x, y, w_css, h_css)
        save_settings(self.settings)
        return {"x": x, "y": y}

    def save(self, extra):
        if isinstance(extra, dict):
            self.settings.update(extra)
        r = self._rect()
        if r:
            self.settings.update({"x": r.left, "y": r.top})
        save_settings(self.settings)
        return True

    def quit(self):
        write_log("quit requested")
        self._cancel_roam()
        self._cancel_fling()
        self.hub.stop()
        r = self._rect()
        if r:
            self.settings.update({"x": r.left, "y": r.top})
        save_settings(self.settings)

        def bye():
            time.sleep(0.2)
            try:
                self._window.destroy()
            except Exception as exc:  # noqa: BLE001
                write_log(f"destroy failed: {exc!r}")
            time.sleep(1.5)
            os._exit(0)

        threading.Thread(target=bye, daemon=True).start()
        return True


def main():
    write_log("---- start ----")
    # single instance: a second double-click should not start another pet
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.restype = wt.HANDLE
    kernel32.CreateMutexW.argtypes = [wt.LPVOID, wt.BOOL, wt.LPCWSTR]
    mutex = kernel32.CreateMutexW(None, False, "LeitingMiaoDesktopPet_v1")
    if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        user32.MessageBoxW(None, "雷霆喵已经在桌面上啦～", "雷霆喵", 0x40)
        return

    _, base = start_server(ROOT)
    api = Api()
    # Start fully on screen (Chromium freezes pages of hidden/off-screen windows) and cover the
    # window with an opaque loading screen until the page reports ready.
    x, y = api.settings.get("x"), api.settings.get("y")
    if x is None or y is None:
        x, y = api._default_xy(int(api.settings["w"]), int(api.settings["h"]))
    window = webview.create_window(
        TITLE,
        url=base + "pet.html",
        js_api=api,
        width=api.settings["w"],
        height=api.settings["h"],
        x=int(x),
        y=int(y),
        transparent=True,
        frameless=True,
        on_top=True,
        easy_drag=False,
        resizable=False,
        hidden=False,
        focus=False,
    )
    api._window = window
    write_log("webview.start")
    webview.start(debug=False, storage_path=str(APP_DIR / "webview"))
    write_log("---- exit ----")


if __name__ == "__main__":
    main()
