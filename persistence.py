"""Optional autosave of an in-progress game to Supabase.

Off unless SUPABASE_URL and SUPABASE_KEY are set (environment variables, or Streamlit
secrets). With them unset the app behaves exactly as it always has: nothing is saved and a
browser refresh starts a new game.

When on, the first real change creates a game with a random id, puts it in the page URL
(?game=<id>) and saves the whole sheet after every change. Reopening that URL, e.g. after a
refresh, restores the sheet. The id is the only credential: anyone with the link can read and
edit that game, so the saved state should hold nothing sensitive (names and scores only).

Saving is best-effort. If the service is slow or down the app keeps working and shows a
warning. A game that could not be *loaded* is never saved over.

The database side (table, row-level security, the two functions called here) is proposed in
supabase/schema.sql. The Supabase key is used only on the server and is never rendered or logged.
"""
import functools
import json
import logging
import os
import time
import urllib.parse
import uuid

import requests
import streamlit as st

log = logging.getLogger(__name__)

GAME_PARAM = "game"
REQUEST_TIMEOUT_SECONDS = 3
RETRY_AFTER_SECONDS = 30
MAX_STATE_BYTES = 16 * 1024  # roughly matches the check constraint in supabase/schema.sql
_SESSION_KEY = "_persistence"


class StoreError(RuntimeError):
    """The save service could not be reached or refused the request. Message is safe to log."""


class SupabaseStore:
    """Calls the load_game / save_game functions through Supabase's REST (PostgREST) API."""

    def __init__(self, url, key, session=None):
        self._rpc_url = url.rstrip("/") + "/rest/v1/rpc/"
        self._session = session or requests.Session()
        self._headers = {"apikey": key, "Content-Type": "application/json"}
        # Legacy anon/service keys are JWTs and are also sent as a bearer token. The newer
        # "sb_publishable_..." keys are not JWTs and go in the apikey header only.
        if key.startswith("eyJ"):
            self._headers["Authorization"] = f"Bearer {key}"

    def _call(self, function, payload):
        try:
            response = self._session.post(
                self._rpc_url + function,
                json=payload,
                headers=self._headers,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException as err:
            status = getattr(getattr(err, "response", None), "status_code", None)
            # Deliberately not chaining or echoing err: keep URLs and headers out of logs.
            raise StoreError(f"{function} failed ({type(err).__name__}, HTTP status {status})") from None
        return response

    def load(self, app, game_id):
        """Return the saved state dict, or None if there is no such game."""
        response = self._call("load_game", {"p_app": app, "p_id": game_id})
        try:
            state = response.json()
        except ValueError:
            raise StoreError("load_game returned something that is not JSON") from None
        return state if isinstance(state, dict) else None

    def save(self, app, game_id, state):
        if len(json.dumps(state)) > MAX_STATE_BYTES:
            raise StoreError("game state is too large to save")
        self._call("save_game", {"p_app": app, "p_id": game_id, "p_state": state})


def _setting(name):
    value = os.environ.get(name)
    if not value:
        try:
            value = st.secrets.get(name)
        except Exception:  # no secrets.toml, or it can't be read
            value = None
    return str(value).strip() if value else None


@functools.lru_cache(maxsize=4)
def _store_for(url, key):
    return SupabaseStore(url, key)


def _is_acceptable_url(url):
    """https anywhere, or plain http to this machine only (the key must not cross a network in the clear)."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme == "https":
        return bool(parts.hostname)
    return parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1")


def get_store():
    """Return the configured store, or None if persistence is not set up."""
    url, key = _setting("SUPABASE_URL"), _setting("SUPABASE_KEY")
    if not (url and key):
        return None
    if not _is_acceptable_url(url):
        log.warning("SUPABASE_URL must start with https:// (plain http is only allowed for localhost); saving is off")
        return None
    return _store_for(url, key)


def _game_id_from_url():
    raw = st.query_params.get(GAME_PARAM)
    try:
        return str(uuid.UUID(raw)) if raw else None
    except ValueError:
        return None


def forget_game():
    """Detach from the current game (used by "New game"); the saved copy is left alone."""
    try:
        del st.query_params[GAME_PARAM]
    except KeyError:
        pass


def _dump(state):
    return json.dumps(state, sort_keys=True)


class GameSession:
    """Connects the current Streamlit session to one saved game, if a store is configured."""

    def __init__(self, app):
        self.app = app
        self.store = get_store()
        if _SESSION_KEY not in st.session_state:
            st.session_state[_SESSION_KEY] = {
                "restored": False,
                "game_id": None,
                "last_saved": None,
                "paused": False,  # set when a game could not be loaded: don't save over it
                "error": False,
                "retry_at": 0.0,
            }
        self._s = st.session_state[_SESSION_KEY]

    @property
    def enabled(self):
        return self.store is not None

    def restore(self):
        """Load the game named in the URL, once per browser session. Returns its state or None."""
        s = self._s
        if not self.enabled or s["restored"]:
            return None
        s["restored"] = True
        game_id = _game_id_from_url()
        if game_id is None:
            return None
        s["game_id"] = game_id
        try:
            state = self.store.load(self.app, game_id)
        except StoreError as err:
            log.warning("could not load game: %s", err)
            s["paused"] = s["error"] = True
            return None
        if state is not None:
            s["last_saved"] = _dump(state)
        return state

    def mark_unusable(self):
        """The loaded state was not valid for this app; start blank but leave the saved copy alone."""
        self._s["paused"] = True

    def save_if_changed(self, state):
        """Save `state` (a JSON-able dict) if it differs from what was last saved."""
        s = self._s
        if not self.enabled or s["paused"]:
            return
        payload = _dump(state)
        if payload == s["last_saved"]:
            return
        if s["last_saved"] is None:
            # First look at the sheet (nothing loaded or saved yet): remember it as the baseline, but
            # don't write anything for a mere page view, even one that arrived with an unknown ?game= id.
            s["last_saved"] = payload
            return
        if time.monotonic() < s["retry_at"]:
            return
        if s["game_id"] is None:
            s["game_id"] = str(uuid.uuid4())
        try:
            self.store.save(self.app, s["game_id"], state)
        except StoreError as err:
            log.warning("could not save game: %s", err)
            s["error"] = True
            s["retry_at"] = time.monotonic() + RETRY_AFTER_SECONDS
            return
        s["error"] = False
        s["last_saved"] = payload
        st.query_params[GAME_PARAM] = s["game_id"]

    def render_status(self):
        """One line telling the player whether the game is being saved."""
        if not self.enabled:
            return
        s = self._s
        if s["paused"]:
            st.warning("Couldn't load the saved game, so saving is paused to avoid overwriting it. Refresh to try again.")
        elif s["error"]:
            st.warning("Couldn't save just now. Your scores are still here, but a refresh would lose them. Retrying shortly.")
        elif s["game_id"] and s["last_saved"] is not None:
            st.caption("💾 Saved automatically. Bookmark this page's link to come back to this game.")
        else:
            st.caption("💾 This game will be saved automatically once you enter something.")
