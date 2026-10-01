"""The score sheet with saving turned on, using an in-memory stand-in for the store."""
import copy
import uuid
from types import SimpleNamespace

import pytest

import persistence
from conftest import COLORS, checkbox, cross, lock_mode, new_app, penalty, sidebar_scores, sidebar_total
from persistence import StoreError

GAME_ID = "0b8f3c1e-6f5d-4d43-9d1c-2f0f5a4b7e11"


class FakeStore:
    def __init__(self):
        self.games = {}
        self.saves = []
        self.loads = []
        self.fail_load = False
        self.fail_save = False

    def load(self, app, game_id):
        self.loads.append((app, game_id))
        if self.fail_load:
            raise StoreError("load_game failed (ConnectionError, HTTP status None)")
        return copy.deepcopy(self.games.get((app, game_id)))

    def save(self, app, game_id, state):
        if self.fail_save:
            raise StoreError("save_game failed (Timeout, HTTP status None)")
        self.games[(app, game_id)] = copy.deepcopy(state)
        self.saves.append((app, game_id))


@pytest.fixture
def store(monkeypatch):
    fake = FakeStore()
    monkeypatch.setattr(persistence, "get_store", lambda: fake)
    return fake


def blank_state():
    return {
        "v": 1,
        "crosses": {c: [False] * 11 for c in COLORS},
        "lock_mode": {c: "" for c in COLORS},
        "penalty": 0,
    }


def saved_state():
    """red: 5 crosses locked for points; green: 2 crosses; blue: locked without points; 2 penalties."""
    state = blank_state()
    state["crosses"]["red"] = [True] * 5 + [False] * 6
    state["crosses"]["green"] = [True, True] + [False] * 9
    state["lock_mode"].update(red="Points", blue="No Points")
    state["penalty"] = 2
    return state


def mutated(**changes):
    """saved_state() with a top-level key replaced."""
    state = saved_state()
    state.update(changes)
    return state


def captions(at):
    return [c.value for c in at.sidebar.caption]


def warnings(at):
    return [w.value for w in at.sidebar.warning]


# --- when saving is not configured --------------------------------------------------------


def test_without_a_store_nothing_is_saved_and_the_ui_is_unchanged(monkeypatch):
    monkeypatch.setattr(persistence, "get_store", lambda: None)
    at = new_app()
    cross(at, "red", 2)
    assert sidebar_scores(at)["Red"] == 1
    assert "game" not in at.query_params
    assert captions(at) == [] and warnings(at) == []


# --- creating and updating a game ---------------------------------------------------------


def test_a_page_view_alone_saves_nothing(store):
    at = new_app()
    at.run()
    assert store.saves == [] and store.loads == []
    assert "game" not in at.query_params
    assert any("once you enter something" in c for c in captions(at))


def test_first_change_creates_a_game_and_puts_its_id_in_the_url(store):
    at = new_app()
    cross(at, "red", 2)
    ((app_name, game_id),) = set(store.games)
    assert app_name == "qwixx"
    assert str(uuid.UUID(game_id)) == game_id
    assert at.query_params["game"] == [game_id]
    expected = blank_state()
    expected["crosses"]["red"][0] = True
    assert store.games[("qwixx", game_id)] == expected
    assert any("Saved automatically" in c for c in captions(at))


def test_crosses_locks_and_penalties_are_all_saved(store):
    at = new_app()
    for number in range(2, 7):
        cross(at, "red", number)
    lock_mode(at, "red").select("Points").run()
    at.run()  # the lock is applied one run late (an existing quirk), so give it that run
    penalty(at, 0).check().run()
    (state,) = store.games.values()
    assert state["crosses"]["red"] == [True] * 5 + [False] * 6
    assert state["lock_mode"]["red"] == "Points"
    assert state["penalty"] == 1


def test_later_changes_update_the_same_game(store):
    at = new_app()
    cross(at, "red", 2)
    cross(at, "yellow", 2)
    assert len({game_id for _, game_id in store.saves}) == 1
    (state,) = store.games.values()
    assert state["crosses"]["red"][0] and state["crosses"]["yellow"][0]


def test_a_rerun_with_nothing_changed_does_not_save_again(store):
    at = new_app()
    cross(at, "red", 2)
    saves = len(store.saves)
    at.run()
    at.run()
    assert len(store.saves) == saves


# --- reopening a game (the refresh case) --------------------------------------------------


def test_reopening_the_link_restores_crosses_locks_and_penalties(store):
    store.games[("qwixx", GAME_ID)] = saved_state()
    at = new_app(game=GAME_ID)
    assert not at.exception and warnings(at) == []
    assert sidebar_scores(at) == {"Red": 21, "Yellow": 0, "Green": 3, "Blue": 0, "Penalties": -10}
    assert sidebar_total(at) == 21 + 3 - 10
    assert "Red 🔒" in [m.label.strip() for m in at.sidebar.metric]
    assert [checkbox(at, f"red_{n}").value for n in range(2, 8)] == [True] * 5 + [False]
    assert lock_mode(at, "red").value == "Points" and lock_mode(at, "blue").value == "No Points"
    assert all(checkbox(at, f"red_{n}").disabled for n in range(2, 13))  # locked rows stay frozen
    assert [checkbox(at, f"pen_{i}").value for i in range(4)] == [True, True, False, False]
    assert store.saves == []  # opening a game does not rewrite it


def test_a_refresh_round_trip_returns_to_the_same_game(store):
    first = new_app()
    for number in (2, 3, 4):
        cross(first, "green", 14 - number)  # green runs 12, 11, 10
    penalty(first, 0).check().run()
    game_id = next(iter(store.games))[1]
    reopened = new_app(game=game_id)  # a new browser session, same URL
    assert sidebar_scores(reopened)["Green"] == 6 and sidebar_scores(reopened)["Penalties"] == -5


def test_restored_game_can_be_edited_and_saves_back_to_the_same_id(store):
    store.games[("qwixx", GAME_ID)] = saved_state()
    at = new_app(game=GAME_ID)
    cross(at, "yellow", 2)
    assert store.saves == [("qwixx", GAME_ID)]
    assert store.games[("qwixx", GAME_ID)]["crosses"]["yellow"][0] is True
    assert sidebar_scores(at)["Yellow"] == 1


def test_an_unknown_game_id_starts_blank_and_writes_nothing_until_a_change(store):
    at = new_app(game=GAME_ID)
    assert sidebar_total(at) == 0 and store.saves == [] and not at.exception
    cross(at, "red", 2)
    assert store.saves == [("qwixx", GAME_ID)]


@pytest.mark.parametrize("bad", ["not-a-uuid", "../../etc/passwd", "0b8f3c1e", ""])
def test_a_malformed_game_param_is_ignored(store, bad):
    at = new_app(game=bad)
    assert store.loads == [] and not at.exception and sidebar_total(at) == 0


# --- failures: never lose data, never crash -----------------------------------------------


def test_if_the_saved_game_cannot_be_loaded_saving_is_paused_so_it_is_not_overwritten(store):
    store.games[("qwixx", GAME_ID)] = saved_state()
    before = copy.deepcopy(store.games)
    store.fail_load = True
    at = new_app(game=GAME_ID)
    assert any("saving is paused" in w for w in warnings(at))
    cross(at, "yellow", 2)
    store.fail_load = False  # even once the service is back, this session must not write
    cross(at, "yellow", 3)
    assert store.saves == [] and store.games == before
    assert sidebar_scores(at)["Yellow"] == 3  # the sheet itself keeps working


def _without(state, path):
    state = copy.deepcopy(state)
    *parents, last = path
    target = state
    for key in parents:
        target = target[key]
    del target[last]
    return state


def _with(state, path, value):
    state = copy.deepcopy(state)
    *parents, last = path
    target = state
    for key in parents:
        target = target[key]
    target[last] = value
    return state


@pytest.mark.parametrize(
    "bad_state",
    [
        mutated(v=2),
        {"v": 1},
        {},
        _without(saved_state(), ["crosses", "blue"]),
        _with(saved_state(), ["crosses", "purple"], [False] * 11),
        _with(saved_state(), ["crosses", "red"], [True] * 10),  # wrong length
        _with(saved_state(), ["crosses", "red"], [1] * 5 + [0] * 6),  # not booleans
        _with(saved_state(), ["crosses", "red"], "xxxxxxxxxxx"),
        _with(saved_state(), ["lock_mode", "green"], "Everything"),
        _with(saved_state(), ["lock_mode", "green"], "Points"),  # only 2 crosses: can't be locked for points
        _without(saved_state(), ["lock_mode", "yellow"]),
        mutated(penalty=5),
        mutated(penalty=-1),
        mutated(penalty=True),
        mutated(penalty="2"),
        mutated(crosses=["red"]),
        mutated(lock_mode=None),
    ],
)
def test_an_invalid_saved_state_is_ignored_and_never_overwritten(store, bad_state):
    store.games[("qwixx", GAME_ID)] = bad_state
    before = copy.deepcopy(store.games)
    at = new_app(game=GAME_ID)
    assert not at.exception
    assert sidebar_total(at) == 0
    assert any("saving is paused" in w for w in warnings(at))
    cross(at, "yellow", 2)
    assert store.games == before


def test_a_failed_save_warns_but_the_sheet_keeps_working_and_it_retries(store, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(persistence, "time", SimpleNamespace(monotonic=lambda: now[0]))
    store.fail_save = True
    at = new_app()
    cross(at, "red", 2)
    assert any("Couldn't save" in w for w in warnings(at))
    assert sidebar_scores(at)["Red"] == 1 and not at.exception
    assert "game" not in at.query_params  # no link to a game that was never stored

    store.fail_save = False
    cross(at, "red", 3)  # still inside the retry back-off: no attempt is made
    assert store.saves == []

    now[0] += persistence.RETRY_AFTER_SECONDS + 1
    cross(at, "red", 4)
    assert len(store.saves) == 1 and warnings(at) == []
    (state,) = store.games.values()
    assert state["crosses"]["red"][:4] == [True, True, True, False]  # the retry saved everything, not just the last tick


# --- Reset --------------------------------------------------------------------------------


def test_reset_blanks_the_sheet_detaches_from_the_saved_game_and_keeps_it(store):
    at = new_app()
    cross(at, "red", 2)
    old_id = next(iter(store.games))[1]

    next(b for b in at.sidebar.button if "Reset" in b.label).click().run()
    assert sidebar_total(at) == 0 and not any(c.value for c in at.checkbox)
    assert "game" not in at.query_params
    assert ("qwixx", old_id) in store.games  # the finished game is still there

    cross(at, "red", 2)
    assert len(store.games) == 2 and {g for _, g in store.games} != {old_id}
