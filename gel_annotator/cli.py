"""
Slots Gel Annotator — command-line entry point.

Usage::

    slots                       # launch on the default port; opens your browser
    slots image.tif             # launch and auto-load a gel image
    slots --port 9000           # use a custom port
    slots --host 0.0.0.0        # bind on all interfaces (for LAN access)
    slots --no-browser          # do NOT pop the browser (useful for headless)
    slots --install             # create a desktop shortcut and exit
    slots --update              # check PyPI for an update; install if newer
    slots --no-update           # skip the automatic update check this run
    slots --version             # print the version and exit

The launcher single-instances itself: re-running ``slots`` while it is
already running on the chosen port reuses the existing tab instead of
spawning a duplicate server. A lock file at ``~/.slots-gel-annotator/
server.lock`` records the running port + PID; stale locks are detected
and cleared automatically.

The auto-update check runs on every launch — same behaviour as the
sister tool ``proker``. The check uses a 3 s timeout so a slow or
absent network never holds up startup for long; when an update is
available the user gets a yes/no prompt (terminal-style if a TTY is
attached, tkinter dialog otherwise) and, on accept, ``pip install
--upgrade`` runs in-place. Set ``--no-update`` to bypass the check
entirely.
"""

import argparse
import atexit
import json
import os
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────
# Per-user state directory. Holds the single-instance lock, the
# version marker for first-run welcome, and the optional update log.
# Created on demand.
# Fork note: config dir, lock file, and port all differ from upstream
# Slots so this tool and a stock `slots` install can be running at the
# same time without fighting over a lock file or a port. Changing any of
# these back would make the two instances silently adopt each other's
# server.
_CONFIG_DIR = Path.home() / ".femsa-quant"
_LOCK_FILE = _CONFIG_DIR / "server.lock"
_FIRST_RUN_MARKER = _CONFIG_DIR / ".shortcut_prompted"
_VERSION_MARKER = _CONFIG_DIR / ".installed_version"

# Auto-update is DISABLED in this fork. Upstream ships to PyPI as
# `slotsgeltool`; a version check against that package would compare
# apples to oranges and, on accept, `pip install --upgrade slotsgeltool`
# would overwrite this fork's gel_annotator package with upstream's —
# silently deleting the quantification layer. Pull upstream changes with
# git instead:  git fetch upstream && git merge upstream/main
_PYPI_PACKAGE = None
_DEFAULT_PORT = 8063

# Display name kept in one place so the printed banner, the desktop-
# shortcut label, and the dialog titles all stay in lock-step.
_APP_NAME = "fEMSA Quant (Slots fork)"


# ── Welcome banner ───────────────────────────────────────────────────
def _show_welcome_if_new() -> None:
    """Print a one-time welcome banner on first run / after an upgrade.

    Compared against ``_VERSION_MARKER`` so each new installed version
    triggers exactly one welcome. Failing to read or write the marker
    is non-fatal — the welcome just shows again next time.
    """
    ver = _get_installed_version()
    try:
        prev = _VERSION_MARKER.read_text().strip() if _VERSION_MARKER.exists() else None
    except Exception:
        prev = None
    if prev == ver:
        return

    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _VERSION_MARKER.write_text(ver)
    except Exception:
        pass

    # If stdout was hijacked (e.g. ``pythonw.exe`` on Windows) we silently
    # skip the banner instead of crashing on a NoneType.write call.
    try:
        if sys.stdout is None:
            return
        sys.stdout.write("")
    except Exception:
        return

    is_upgrade = prev is not None
    print()
    print(f"  {'=' * 44}")
    if is_upgrade:
        print(f"    {_APP_NAME} updated to v{ver}")
    else:
        print(f"    {_APP_NAME} v{ver} installed")
    print(f"  {'=' * 44}")
    print()
    if not is_upgrade:
        print("  Supported formats:")
        print("    PNG, JPEG, TIFF (8-bit), .raw16 / 16-bit TIFF")
        print()
        print("  Quick start:")
        print("    - Open a gel image (Open or drop on the canvas)")
        print("    - Click 'Draw region' and trace the analysis area")
        print("    - Annotate lanes / brackets / ladder bands")
        print("    - Export as SVG (vector) or PNG (raster)")
        print()
    print("  Commands:")
    print("    slots                 Launch the annotator")
    print("    slots image.tif       Open a file on launch")
    print("    slots --update        Check for updates")
    print("    slots --install       Create a desktop shortcut")
    print("    slots --version       Show installed version")
    print()


# ── Version / update checks ──────────────────────────────────────────
def _get_installed_version() -> str:
    """Return the installed package version, or "0.0.0" if it can't be read."""
    try:
        from gel_annotator import __version__
        return __version__
    except Exception:
        return "0.0.0"


def _get_pypi_version() -> str | None:
    """Return the latest version on PyPI, or None on any failure.

    Uses ``urllib.request`` (stdlib) so we don't pull in ``requests`` for
    a single GET. 3-second timeout — slow networks shouldn't block the
    user from opening their gel image.
    """
    # Fork: no PyPI package to check against. Short-circuit rather than
    # letting the request 404 — otherwise every launch pays the 3 s
    # timeout to learn nothing.
    if not _PYPI_PACKAGE:
        return None
    try:
        import urllib.request
        url = f"https://pypi.org/pypi/{_PYPI_PACKAGE}/json"
        with urllib.request.urlopen(url, timeout=3) as resp:
            data = json.loads(resp.read())
            return data["info"]["version"]
    except Exception:
        return None


def _version_tuple(v: str) -> tuple[int, ...]:
    """Parse "1.2.3" into (1, 2, 3) for comparison; tolerate junk."""
    try:
        return tuple(int(x) for x in v.split(".")[:3])
    except Exception:
        return (0, 0, 0)


def _do_upgrade() -> bool:
    """Run ``pip install --upgrade`` for our package.

    Falls back to a ``--user`` install if the system-level install
    fails (which happens on Linux with externally-managed Python or on
    macOS Homebrew installs). Returns True on success.
    """
    # Fork: refuse outright. `pip install --upgrade slotsgeltool` would
    # overwrite this fork's gel_annotator package with upstream's and
    # take the quantification layer with it.
    if not _PYPI_PACKAGE:
        _log("  Auto-update is disabled in this fork. "
             "Update with: git -C <repo> pull  (then reinstall if needed)")
        return False
    cmds = [
        [sys.executable, "-m", "pip", "install", "--upgrade", _PYPI_PACKAGE],
        [sys.executable, "-m", "pip", "install", "--upgrade", "--user", _PYPI_PACKAGE],
    ]
    last_err = None
    for cmd in cmds:
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if result.returncode == 0:
                return True
            last_err = (result.stderr or "").strip()[:200]
        except Exception as e:
            last_err = str(e)
    if last_err:
        _log(f"  pip failed: {last_err}")
    return False


def _log(msg: str) -> None:
    """Best-effort logging to stdout AND a rolling update.log file."""
    try:
        print(msg)
    except Exception:
        pass
    try:
        log = _CONFIG_DIR / "update.log"
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(log, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except Exception:
        pass


def check_and_update(force: bool = False) -> tuple[str, str | None]:
    """Manual update flow used by ``--update``.

    The ``force`` parameter is kept for API compatibility — callers still
    pass it — but the launcher no longer throttles update checks: every
    invocation hits PyPI fresh. The 3 s timeout in ``_get_pypi_version``
    keeps the cost bounded when the network is slow or absent.

    Returns a (status, version) tuple where status is one of:
        'updated' — the upgrade ran and succeeded
        'failed'  — pip ran and reported an error
        'current' — already on the latest version
        'skip'    — couldn't reach PyPI
    """
    installed = _get_installed_version()
    latest = _get_pypi_version()

    if latest is None:
        return ("skip", None)
    if _version_tuple(latest) <= _version_tuple(installed):
        return ("current", None)

    _log(f"  Updating {_APP_NAME}: {installed} -> {latest} ...")
    if _do_upgrade():
        _log(f"  Updated to {latest}.")
        return ("updated", latest)
    return ("failed", latest)


def _check_update_with_prompt() -> None:
    """Synchronous update prompt — runs on every regular launch.

    Prompts on the terminal if there is one; falls back to a tkinter
    dialog if running headless (e.g. ``pythonw.exe`` from a Windows
    shortcut). Either way the user gets a yes/no choice — we never
    install behind their back. Bounded by the 3 s PyPI fetch timeout
    so a slow network never holds up startup for long.
    """
    try:
        installed = _get_installed_version()
        latest = _get_pypi_version()
        if latest is None or _version_tuple(latest) <= _version_tuple(installed):
            return

        has_terminal = _has_terminal()
        should_update = False

        if has_terminal:
            try:
                print(f"\n  Update available: {installed} -> {latest}")
                answer = input("  Install update now? [Y/n]: ").strip()
                should_update = answer.lower() != "n"
            except (EOFError, OSError):
                should_update = _tk_update_prompt(installed, latest)
        else:
            should_update = _tk_update_prompt(installed, latest)

        if should_update:
            _log(f"  Updating {_APP_NAME}: {installed} -> {latest} ...")
            if _do_upgrade():
                _log(f"  Updated to {latest}.")
                if has_terminal:
                    print(f"\n  Please run 'slots' again to launch the new version.\n")
                    sys.exit(0)
                else:
                    try:
                        import tkinter as tk
                        from tkinter import messagebox
                        root = tk.Tk(); root.withdraw()
                        messagebox.showinfo(
                            _APP_NAME,
                            f"Updated to v{latest}.\n\n"
                            f"The annotator will now relaunch."
                        )
                        root.destroy()
                    except Exception:
                        pass
                    subprocess.Popen([sys.executable, "-m", "gel_annotator", "--no-update"])
                    sys.exit(0)
            else:
                _log("  Update failed. Retry with: slots --update")
    except Exception:
        # Update prompts are best-effort. A failure here must not stop
        # the user from launching the app.
        pass


def _tk_update_prompt(installed: str, latest: str) -> bool:
    """Show a yes/no dialog for the update prompt; returns True on accept."""
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk(); root.withdraw()
        answer = messagebox.askyesno(
            f"{_APP_NAME} Update",
            f"A new version is available: {installed} -> {latest}\n\n"
            "Install the update now?",
        )
        root.destroy()
        return answer
    except Exception:
        return False


# ── Single-instance detection ────────────────────────────────────────
def _pid_alive(pid: int) -> bool:
    """Cross-platform check for whether a process is still running."""
    if sys.platform == "win32":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x100000, False, pid)
        if handle:
            kernel32.CloseHandle(handle)
            return True
        return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError, PermissionError):
        return False


def _http_check(host: str, port: int, timeout: float = 0.5) -> bool:
    """Probe the FastAPI ``/healthz`` endpoint to confirm a server is alive.

    Returns True only when the server replies with the expected status.
    Used to verify a stale lock file isn't pointing at a dead PID.
    """
    try:
        import urllib.request
        h = "localhost" if host in ("0.0.0.0", "127.0.0.1") else host
        url = f"http://{h}:{port}/healthz"
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read()).get("status") == "ok"
    except Exception:
        return False


def _check_existing_server(host: str, port: int) -> str | None:
    """Return the URL of an already-running instance, or None.

    Two paths to a positive answer:
      1. The lock file points at a live PID AND the /healthz endpoint
         is reachable. We trust the lock's port (it might differ from
         the requested one if the user re-ran with a different --port).
      2. No lock file, but /healthz on the requested host:port answers.
         Some other instance is bound there; reuse it.

    Stale locks (PID dead or HTTP unreachable) are deleted so the next
    launch can claim the port cleanly.
    """
    try:
        if _LOCK_FILE.exists():
            data = json.loads(_LOCK_FILE.read_text())
            lock_host = data.get("host", "127.0.0.1")
            lock_port = data.get("port", _DEFAULT_PORT)
            lock_pid = data.get("pid")
            if lock_pid and _pid_alive(lock_pid) and _http_check(lock_host, lock_port):
                h = "localhost" if lock_host in ("0.0.0.0", "127.0.0.1") else lock_host
                return f"http://{h}:{lock_port}"
            _LOCK_FILE.unlink(missing_ok=True)
    except Exception:
        pass

    if _http_check(host, port):
        h = "localhost" if host in ("0.0.0.0", "127.0.0.1") else host
        return f"http://{h}:{port}"
    return None


def _write_lock(host: str, port: int) -> None:
    """Record this process's host/port/PID so re-launches can find us."""
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _LOCK_FILE.write_text(
            json.dumps({"host": host, "port": port, "pid": os.getpid()})
        )
    except Exception:
        pass


def _remove_lock() -> None:
    """Remove the lock file IF it points to our PID. Atexit hook."""
    try:
        if _LOCK_FILE.exists():
            data = json.loads(_LOCK_FILE.read_text())
            if data.get("pid") == os.getpid():
                _LOCK_FILE.unlink()
    except Exception:
        pass


# ── Shutdown handlers (terminal close, OS logoff, etc.) ──────────────
#
# uvicorn already cleans up on graceful exits — Ctrl-C (SIGINT) and
# `kill <pid>` (SIGTERM) both run its signal handler, which shuts the
# server down, releases the listening socket, and lets main() return so
# atexit fires _remove_lock. Two additional cases need explicit
# handling so the lock file doesn't leak:
#
#   • SIGHUP on POSIX (terminal hangup / closed): uvicorn doesn't
#     register for SIGHUP, so the default action terminates the
#     process WITHOUT running atexit.
#
#   • CTRL_CLOSE_EVENT on Windows (cmd window X / End Task), plus
#     CTRL_LOGOFF / CTRL_SHUTDOWN: these are not POSIX signals and do
#     not reach Python's signal module. Windows force-kills the
#     process after a ~5 s grace period during which our console
#     control handler runs.
#
# In all abnormal-exit paths the OS automatically closes the listening
# socket when the process dies — the port IS released immediately.
# What lingers is the protocol-level TIME_WAIT state (~30-120 s) before
# the same port can be cleanly re-bound; the launcher's _find_free_port
# falls forward to the next available port during that window so
# re-launching slots is never blocked. The handler below only worries
# about the lock file and (best-effort) the SO_REUSEADDR fast-path.
_WIN_CTRL_HANDLER_REF = None  # keep WinAPI callback from being GC'd


def _install_shutdown_handlers() -> None:
    """Install OS-level shutdown hooks so the lock file is cleaned up
    on terminal close / window X / OS logoff — not just on graceful
    Ctrl-C exit. Idempotent: safe to call once at launch.
    """
    import signal as _signal

    def _on_signal(sig, _frame):
        _remove_lock()
        # Restore the default handler and re-raise so the process
        # actually terminates. Without this, returning from a Python
        # signal handler tells the kernel the signal was "handled" —
        # the default terminate action is suppressed and the process
        # keeps running, ignoring the user's request to close.
        try:
            _signal.signal(sig, _signal.SIG_DFL)
            os.kill(os.getpid(), sig)
        except Exception:
            # Last-ditch: bypass cleanup and just exit. Better than
            # leaving the process running after the user asked it to
            # stop.
            os._exit(0)

    # SIGHUP doesn't exist on Windows; getattr-None handles that.
    # SIGTERM / SIGINT are intentionally NOT registered here —
    # uvicorn already handles them gracefully, and overriding would
    # bypass uvicorn's clean-server-shutdown path.
    sig_hup = getattr(_signal, "SIGHUP", None)
    if sig_hup is not None:
        try:
            _signal.signal(sig_hup, _on_signal)
        except (OSError, ValueError):
            pass

    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            CTRL_CLOSE_EVENT    = 2   # window X button or End Task
            CTRL_LOGOFF_EVENT   = 5
            CTRL_SHUTDOWN_EVENT = 6

            HANDLER_FUNC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)

            def _ctrl_handler(ctrl_type):
                if ctrl_type in (CTRL_CLOSE_EVENT,
                                 CTRL_LOGOFF_EVENT,
                                 CTRL_SHUTDOWN_EVENT):
                    _remove_lock()
                    # Return False to let Windows continue with its
                    # default termination path. Returning True would
                    # tell Windows the event was handled and keep the
                    # process running, but we WANT to exit — and
                    # there's no safe way to gracefully shut uvicorn
                    # down from this thread (Windows allows only ~5 s
                    # before force-kill regardless).
                    return False
                # CTRL_C_EVENT / CTRL_BREAK_EVENT: let Python's normal
                # signal infrastructure handle them.
                return False

            global _WIN_CTRL_HANDLER_REF
            _WIN_CTRL_HANDLER_REF = HANDLER_FUNC(_ctrl_handler)
            ctypes.windll.kernel32.SetConsoleCtrlHandler(
                _WIN_CTRL_HANDLER_REF, True
            )
        except Exception:
            # Best-effort. If we can't install the console handler,
            # we still have atexit and the PID-liveness recovery on
            # the next launch — slots stays usable.
            pass


# ── First-run shortcut prompt ────────────────────────────────────────
def _offer_shortcut_install() -> None:
    """On first launch, prompt to create a desktop shortcut."""
    if _FIRST_RUN_MARKER.exists():
        return
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _FIRST_RUN_MARKER.write_text("prompted")
    except Exception:
        return

    # Terminal flow first — quick and out of the way for power users.
    try:
        answer = input("  Create a desktop shortcut? [Y/n]: ").strip()
        if answer.lower() != "n":
            _try_install_shortcut()
            print()
        return
    except (EOFError, OSError, KeyboardInterrupt):
        print()

    # Headless / pythonw fallback — pop a tk dialog.
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk(); root.withdraw()
        answer = messagebox.askyesno(
            _APP_NAME,
            "Would you like to create a desktop shortcut?\n\n"
            "You can also do this later with:  slots --install",
        )
        root.destroy()
        if answer:
            _try_install_shortcut()
    except Exception:
        pass


def _try_install_shortcut() -> None:
    """Run the shortcut installer; surface any error to the user."""
    try:
        from gel_annotator.install_shortcut import main as install_main
        install_main()
    except ImportError:
        print("  Shortcut creation requires tkinter.")
        print("  Install it with: conda install tk  (or)  apt install python3-tk")
    except Exception as e:
        print(f"  Shortcut creation failed: {e}")
        print("  You can try again later with: slots --install")


# ── Browser opener ───────────────────────────────────────────────────
def _open_when_ready(url: str, timeout: float = 10) -> None:
    """Wait for /healthz to respond, then open the user's default browser.

    We poll instead of unconditionally calling ``webbrowser.open`` so a
    cold-boot uvicorn doesn't hand the user a "site can't be reached"
    page before the server has bound to its port.
    """
    import urllib.request
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(f"{url}/healthz", timeout=0.5)
            break
        except Exception:
            time.sleep(0.2)
    webbrowser.open(url)


def _has_terminal() -> bool:
    """True when stdout is connected to a real terminal (not pythonw)."""
    try:
        if sys.stdout is None:
            return False
        # ``sys.stdout.write('')`` is the cheapest probe — pythonw on
        # Windows raises here even though stdout is non-None.
        sys.stdout.write("")
        return True
    except Exception:
        return False


# ── Port probing ─────────────────────────────────────────────────────
def _find_free_port(host: str, start_port: int, max_tries: int = 20) -> tuple[int, bool]:
    """Probe consecutive ports starting at ``start_port`` and return the
    first one that's actually bindable. Used by the launcher to fall
    forward when the requested port is already in use — by another Slots
    instance whose lock file went stale (very common after a hard crash
    or kill -9), by some unrelated dev server, by a Windows TIME_WAIT
    socket from a previous Slots that exited recently, etc.

    Returns ``(port, fallback_used)`` where ``fallback_used`` is True
    when the returned port differs from ``start_port`` so the caller
    can log it loudly.

    Raises ``RuntimeError`` when no port in ``[start_port,
    start_port + max_tries - 1]`` will bind — the caller should
    propagate a friendly error mentioning the range.

    Note on race conditions: between this probe and the actual
    ``uvicorn.run`` bind, another process could grab the port. We close
    the socket immediately after the probe (rather than holding it)
    because uvicorn doesn't accept a pre-bound fd reliably across
    platforms. The caller wraps ``uvicorn.run`` in one retry to handle
    this rare race.
    """
    import socket
    for offset in range(max_tries):
        port = start_port + offset
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            # No SO_REUSEADDR — we WANT to fail if anyone is on this
            # port, including a TIME_WAIT socket on Windows (matches
            # what uvicorn will do moments later).
            s.bind((host, port))
            return port, (port != start_port)
        except OSError:
            continue
        finally:
            try:
                s.close()
            except Exception:
                pass
    raise RuntimeError(
        f"All ports in {start_port}-{start_port + max_tries - 1} are in use. "
        f"Free a port or pass --port <N> to pick a specific one."
    )


def _run_uvicorn_with_port_retry(app, host: str, port: int, max_extra_tries: int = 5) -> int:
    """Run ``uvicorn.run`` with a small retry loop in case a TOCTOU race
    means the port we just probed got grabbed before uvicorn could bind.
    Falls forward through consecutive ports up to ``max_extra_tries``
    times. Returns the port that actually bound, raises RuntimeError if
    everything fails.

    Re-emits the fallback log line on each shift so the user is always
    looking at the right URL — but in practice the probe in
    ``_find_free_port`` already made this near-impossible to trigger.
    """
    import uvicorn
    last_exc: Exception | None = None
    for offset in range(max_extra_tries + 1):
        try_port = port + offset
        if offset > 0:
            print(f"  Race condition on port {try_port - 1}, trying {try_port}...")
        try:
            uvicorn.run(app, host=host, port=try_port, log_level="warning")
            return try_port
        except OSError as e:
            # Windows: WinError 10048; Linux/Mac: errno 98 (EADDRINUSE).
            msg = str(e).lower()
            if "10048" in msg or "address already in use" in msg or "eaddrinuse" in msg:
                last_exc = e
                continue
            raise
    raise RuntimeError(
        f"Could not bind any port from {port} to {port + max_extra_tries}. "
        f"Last error: {last_exc}"
    )


# ── Entry point ──────────────────────────────────────────────────────
def main() -> int:
    """Parse arguments, launch the server, and open the browser.

    Returns a process exit code (0 on success). Designed to be invoked
    as the ``slots`` console script via the entry point declared in
    ``pyproject.toml``.
    """
    parser = argparse.ArgumentParser(
        prog="slots",
        description=f"{_APP_NAME} — annotate gel images for publication.",
    )
    parser.add_argument(
        "file", nargs="?", default=None,
        help="Path to an image file (PNG / JPEG / TIFF / .raw16) to auto-load",
    )
    parser.add_argument("--port", type=int, default=_DEFAULT_PORT,
                        help=f"Port (default: {_DEFAULT_PORT})")
    parser.add_argument("--host", type=str, default="127.0.0.1",
                        help="Host (default: 127.0.0.1)")
    parser.add_argument("--no-browser", action="store_true",
                        help="Don't open the browser on launch")
    parser.add_argument("--install", action="store_true",
                        help="Create a desktop shortcut and exit")
    parser.add_argument("--update", action="store_true",
                        help="Check PyPI for an update and install if newer")
    parser.add_argument("--no-update", action="store_true",
                        help="Skip the automatic update check this run")
    parser.add_argument("--version", action="store_true",
                        help="Print version and exit")
    args = parser.parse_args()

    if args.version:
        print(f"{_APP_NAME} {_get_installed_version()}")
        return 0

    if args.install:
        _try_install_shortcut()
        return 0

    if args.update:
        if not _PYPI_PACKAGE:
            print(f"  {_APP_NAME} is a git fork and is not distributed on PyPI.")
            print("  Update it with:  git -C <repo> fetch upstream && git merge upstream/main")
            return 0
        status, ver = check_and_update(force=True)
        if status == "updated":
            print(f"  {_APP_NAME} updated to {ver}.")
            print("  Run 'slots' to launch the new version.")
        elif status == "failed":
            print(f"  Update to {ver} failed.")
            print(f"  Check {_CONFIG_DIR / 'update.log'} for details.")
            print(f"  Or update manually: pip install --upgrade {_PYPI_PACKAGE}")
        elif status == "skip":
            print("  Could not reach PyPI. Check your internet connection.")
        else:
            print(f"  {_APP_NAME} {_get_installed_version()} is up to date.")
        return 0

    _show_welcome_if_new()

    # Update check — runs on every launch, terminal or headless.
    # _check_update_with_prompt() handles both cases internally:
    # terminal users get a stdin prompt, headless users get a tkinter
    # dialog. The 3 s PyPI fetch timeout caps the cost when offline.
    if not args.no_update:
        _check_update_with_prompt()

    # Single-instance — if a server is already running, just open the
    # browser at it (or do nothing if --no-browser).
    existing = _check_existing_server(args.host, args.port)
    if existing:
        if not args.no_browser:
            webbrowser.open(existing)
        else:
            print(f"  {_APP_NAME} already running at {existing}")
        return 0

    _offer_shortcut_install()

    # Pass an auto-load file to the server via env var. Resolved to an
    # absolute path so a relative argument works after uvicorn changes
    # cwd internally.
    if args.file:
        filepath = Path(args.file).resolve()
        if not filepath.exists():
            print(f"Error: file not found: {filepath}", file=sys.stderr)
            return 1
        os.environ["SLOTS_AUTOLOAD"] = str(filepath)

    # Probe for an actually-bindable port. If the requested port is
    # taken (stale lock from a hard-killed Slots, an unrelated dev
    # server, a Windows TIME_WAIT socket, etc.), fall forward to the
    # next available one rather than crashing with "address already in
    # use". The single-instance check above already handled the case
    # where another LIVE Slots is on the requested port.
    try:
        actual_port, fell_back = _find_free_port(args.host, args.port)
    except RuntimeError as e:
        print(f"\n  Error: {e}\n", file=sys.stderr)
        return 1

    h_display = "localhost" if args.host in ("0.0.0.0",) else args.host
    url = f"http://{h_display}:{actual_port}"
    if fell_back:
        print(
            f"\n  Note: port {args.port} was in use. "
            f"Using port {actual_port} instead."
        )
    print(f"\n  Starting {_APP_NAME} at {url}\n")

    if not args.no_browser:
        threading.Thread(target=_open_when_ready, args=(url,), daemon=True).start()

    # Windows: switch to the selector event-loop policy BEFORE uvicorn
    # initialises asyncio. The proactor policy (the Win32 default) is
    # incompatible with some libraries we depend on transitively.
    if sys.platform == "win32":
        import asyncio
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    # Late import — uvicorn pulls in ssl + asyncio which are slow on
    # cold start. Doing this AFTER the early-exit paths (--version,
    # --update, --install, single-instance) keeps those paths snappy.
    from gel_annotator.server.main import app

    _write_lock(args.host, actual_port)
    atexit.register(_remove_lock)
    # Install OS shutdown hooks AFTER the lock file exists so they
    # always find something to clean up. Catches terminal close
    # (SIGHUP on POSIX) and window-X / logoff / shutdown on Windows
    # — all paths where atexit would otherwise be skipped.
    _install_shutdown_handlers()

    _run_uvicorn_with_port_retry(app, args.host, actual_port)
    return 0
