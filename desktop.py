"""Is This A Mimic? desktop app (the entry point of IsThisAMimic.exe).

Serves the app privately on 127.0.0.1 and opens it in its own window using
Edge (or Chrome) app mode, which ships with Windows. Party hosting is started
and stopped from inside the app. The process exits once every app window has
been closed.

    python desktop.py          run from source
    python tools/build_exe.py  build dist/IsThisAMimic.exe
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

import server

# Fixed ports so the app's origin (and therefore its saved data) stays the same between runs.
APP_PORTS = range(47651, 47656)
EXIT_AFTER_LAST_WINDOW = 10   # seconds; covers page reloads
EXIT_IF_NO_WINDOW = 120       # seconds; e.g. the window never managed to open


def data_dir():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    path = os.path.join(base, "IsThisAMimic")
    os.makedirs(path, exist_ok=True)
    # Pack Rat's data (the app this replaces) goes: the fresh version starts empty.
    shutil.rmtree(os.path.join(base, "PackRat"), ignore_errors=True)
    return path


def is_app(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/info", timeout=1) as r:
            return bool(json.load(r).get("desktop"))
    except Exception:
        return False


def find_browser():
    env = os.environ.get
    candidates = [
        os.path.join(env("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(env("ProgramFiles", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(env("LOCALAPPDATA", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(env("ProgramFiles", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(env("ProgramFiles(x86)", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(env("LOCALAPPDATA", ""), "Google", "Chrome", "Application", "chrome.exe"),
        shutil.which("msedge"), shutil.which("chrome"),
    ]
    return next((c for c in candidates if c and os.path.isfile(c)), None)


def open_window(url):
    browser = find_browser()
    if not browser:
        webbrowser.open(url)
        return
    profile = os.path.join(data_dir(), "window")  # keeps the app's data separate from normal browsing
    subprocess.Popen([
        browser, f"--app={url}", f"--user-data-dir={profile}", "--window-size=1280,900",
        "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
    ])


def message_box(text):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, "Is This A Mimic?", 0x10)
    except Exception:
        print(text)


def watch_windows(srv):
    """Shut down once no app window has been open for a little while."""
    started = time.time()
    while True:
        time.sleep(2)
        with server.cond:
            p = dict(server.presence)
        idle = time.time() - p["changed"]
        if p["count"] == 0 and ((p["seen"] and idle > EXIT_AFTER_LAST_WINDOW)
                                or (not p["seen"] and time.time() - started > EXIT_IF_NO_WINDOW)):
            server.shutdown_all()
            return


def main():
    # my-data: your own characters, settings and document images, shared by
    # every window or browser tab of the app on this PC.
    server.configure(os.path.join(data_dir(), "party-data"), desktop=True,
                     local_dir=os.path.join(data_dir(), "my-data"))
    srv = None
    for port in APP_PORTS:
        if is_app(port):  # already running: just open another window
            open_window(f"http://127.0.0.1:{port}/")
            return
        try:
            srv = server.make_app_server(port)
            break
        except OSError:
            continue
    if not srv:
        message_box(f"Is This A Mimic? couldn't start: ports {APP_PORTS.start}-{APP_PORTS.stop - 1} are all in use.")
        sys.exit(1)
    open_window(f"http://127.0.0.1:{srv.server_address[1]}/")
    threading.Thread(target=watch_windows, args=(srv,), daemon=True).start()
    srv.serve_forever()
    server.stop_lan()


if __name__ == "__main__":
    main()
