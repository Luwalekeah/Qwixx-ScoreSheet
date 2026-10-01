import logging
from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

APP_PATH = str(Path(__file__).resolve().parent.parent / "qwixx.py")
COLORS = ("red", "yellow", "green", "blue")


@pytest.fixture
def streamlit_warnings(monkeypatch):
    """Collect WARNING+ log lines emitted by Streamlit (deprecations, empty-label notices, ...).

    Streamlit gives some of its loggers propagate=False and their own handler, so a handler
    attached to the "streamlit" logger misses them. Wrapping Logger.handle sees every record.
    """
    messages = []
    original = logging.Logger.handle

    def handle(self, record):
        if record.name.startswith("streamlit") and record.levelno >= logging.WARNING:
            message = record.getMessage()
            if "missing ScriptRunContext" not in message:  # emitted by AppTest itself, not the app
                messages.append(message)
        return original(self, record)

    monkeypatch.setattr(logging.Logger, "handle", handle)
    return messages


def new_app(game=None):
    """Start the app, optionally as if the browser had opened /?game=<game>."""
    at = AppTest.from_file(APP_PATH, default_timeout=30)
    if game is not None:
        at.query_params["game"] = game
    at.run()
    return at


@pytest.fixture
def app():
    at = new_app()
    assert not at.exception, [e.value for e in at.exception]
    return at


def cross(at, color, number):
    """Tick one number in a row (a separate run per tick, like a player would)."""
    next(c for c in at.checkbox if c.key == f"{color}_{number}").check().run()


def checkbox(at, key):
    return next(c for c in at.checkbox if c.key == key)


def lock_mode(at, color):
    return next(s for s in at.selectbox if s.key == f"{color}_mode")


def penalty(at, index):
    return checkbox(at, f"pen_{index}")


def sidebar_scores(at):
    """{'Red': 6, ..., 'Penalties': -10} from the sidebar summary (lock icons stripped)."""
    return {m.label.replace("🔒", "").strip(): int(m.value) for m in at.sidebar.metric}


def sidebar_total(at):
    (text,) = [m.value for m in at.sidebar.markdown if "Total" in m.value]
    return int(text.split(":")[1])
