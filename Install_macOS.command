#!/usr/bin/env bash
# ===============================================================
#   fEMSA Quant — macOS / Linux installer
#
#   Creates a self-contained .venv in this directory, installs the
#   fork into it, and launches. Re-run any time to update.
#
#   FORK NOTE — this differs from upstream Slots on purpose.
#   Upstream's installer runs `pip install -e .` against whatever
#   python3 is first on PATH. That is unsafe here: this fork's
#   package directory is also named `gel_annotator`, so installing
#   it into an environment that already has `slotsgeltool` would
#   have the two distributions fight over the same import name and
#   break the stock `slots` command. A dedicated venv makes the two
#   installs incapable of interfering with each other.
# ===============================================================
set -e

cd "$(dirname "$0")"

echo
echo "  =============================================="
echo "    fEMSA Quant -- installing"
echo "  =============================================="
echo

# Resolve a Python interpreter, newest first. Refuse Python 2.
PY=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
        if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
            PY="$candidate"
            break
        fi
    fi
done

if [ -z "$PY" ]; then
    echo "  ERROR: Python 3.10+ not found."
    echo "  macOS:  brew install python  (or download from https://www.python.org)"
    echo "  Linux:  sudo apt install python3 python3-venv python3-pip python3-tk"
    exit 1
fi

echo "  Using $PY ($("$PY" --version 2>&1))"

if [ ! -x ".venv/bin/python" ]; then
    echo "  Creating .venv ..."
    "$PY" -m venv .venv
else
    echo "  Reusing existing .venv"
fi

echo "  Installing into .venv (this does not touch your system Python) ..."
./.venv/bin/python -m pip install -q -U pip
./.venv/bin/python -m pip install -e .

echo
echo "  Install OK."
echo "    GUI:      ./.venv/bin/femsa          (http://localhost:8063)"
echo "    Fitting:  ./.venv/bin/femsa-fit --help"
echo "    Guide:    docs/femsa-quant.md"
echo
exec ./.venv/bin/femsa
