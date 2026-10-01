"""Behavioural tests that drive the real app through Streamlit's AppTest."""
import re

import pytest
from streamlit.testing.v1 import AppTest

from conftest import APP_PATH, checkbox, cross, lock_mode, penalty, sidebar_scores, sidebar_total


def test_cold_start_is_all_zero(app):
    assert sidebar_scores(app) == {"Red": 0, "Yellow": 0, "Green": 0, "Blue": 0, "Penalties": 0}
    assert sidebar_total(app) == 0
    assert len(app.checkbox) == 4 * 11 + 4  # four rows of 2..12, four penalty boxes
    assert len(app.selectbox) == 4


def test_no_streamlit_warnings_on_a_normal_run(streamlit_warnings):
    """Guards against forward-compat notices, e.g. empty widget labels that a future
    Streamlit release may turn into exceptions."""
    at = AppTest.from_file(APP_PATH, default_timeout=30)
    at.run()
    cross(at, "red", 2)
    assert streamlit_warnings == []


@pytest.mark.parametrize("crosses, points", [(1, 1), (2, 3), (3, 6), (4, 10), (5, 15), (6, 21)])
def test_a_row_scores_the_triangular_number_of_its_crosses(app, crosses, points):
    for number in range(2, 2 + crosses):
        cross(app, "red", number)
    assert sidebar_scores(app)["Red"] == points


def test_green_and_blue_rows_run_from_12_down_to_2(app):
    cross(app, "green", 12)
    cross(app, "green", 11)
    assert sidebar_scores(app)["Green"] == 3
    assert checkbox(app, "green_11").disabled is False  # the last cross can be undone
    assert checkbox(app, "green_10").disabled is False  # ...and the next number is open
    assert checkbox(app, "green_12").disabled is True  # numbers left of the last cross are closed
    cross(app, "blue", 12)
    assert sidebar_scores(app)["Blue"] == 1


def test_numbers_left_of_the_last_cross_are_disabled(app):
    for number in (2, 3, 4):
        cross(app, "red", number)
    assert [checkbox(app, f"red_{n}").disabled for n in (2, 3, 4, 5)] == [True, True, False, False]


def test_rows_are_independent(app):
    cross(app, "red", 2)
    cross(app, "yellow", 2)
    cross(app, "yellow", 3)
    assert sidebar_scores(app) | {"Penalties": 0} == {"Red": 1, "Yellow": 3, "Green": 0, "Blue": 0, "Penalties": 0}
    assert sidebar_total(app) == 4


def test_locking_for_points_needs_five_crosses(app):
    for number in (2, 3, 4):
        cross(app, "red", number)
    lock_mode(app, "red").select("Points").run()
    assert any("Need more" in m.value for m in app.markdown)
    assert sidebar_scores(app)["Red"] == 6  # no lock, no bonus


def test_locking_for_no_points_is_always_allowed_and_freezes_the_row(app):
    cross(app, "red", 2)
    lock_mode(app, "red").select("No Points").run()
    assert not app.exception
    assert all(checkbox(app, f"red_{n}").disabled for n in range(2, 13))
    assert sidebar_scores(app)["Red"] == 1  # locking without points adds nothing
    assert "Red 🔒" in [m.label.strip() for m in app.sidebar.metric]


def test_locking_for_points_freezes_the_row_and_adds_a_bonus(app):
    for number in range(2, 7):
        cross(app, "red", number)
    lock_mode(app, "red").select("Points").run()
    assert all(checkbox(app, f"red_{n}").disabled for n in range(2, 13))
    assert sidebar_scores(app)["Red"] == 21  # 5 crosses, lock counts as a 6th


def test_each_penalty_costs_five_points_and_can_be_taken_back(app):
    cross(app, "red", 2)
    penalty(app, 0).check().run()
    penalty(app, 1).check().run()
    assert sidebar_scores(app)["Penalties"] == -10
    assert sidebar_total(app) == 1 - 10
    penalty(app, 1).uncheck().run()
    assert sidebar_scores(app)["Penalties"] == -5


def test_grand_total_adds_rows_and_subtracts_penalties(app):
    for number in (2, 3):
        cross(app, "red", number)  # 3
    cross(app, "green", 12)  # 1
    penalty(app, 0).check().run()  # -5
    assert sidebar_total(app) == 3 + 1 - 5
    assert any("Grand Total: **-1**" in m.value for m in app.markdown)


def test_reset_starts_over(app):
    for number in (2, 3, 4):
        cross(app, "red", number)
    penalty(app, 0).check().run()
    next(b for b in app.sidebar.button if "Reset" in b.label).click().run()
    assert sidebar_scores(app) == {"Red": 0, "Yellow": 0, "Green": 0, "Blue": 0, "Penalties": 0}
    assert not any(c.value for c in app.checkbox)


# --- Known problems, recorded as strict xfails so they are reproducible and flip loudly when fixed.


def test_lock_bonus_counts_as_an_extra_cross_per_the_rules_text(app):
    for number in range(2, 7):
        cross(app, "red", number)
    lock_mode(app, "red").select("Points").run()
    app.run()
    assert sidebar_scores(app)["Red"] == 21


def test_ui_reflects_a_lock_immediately(app):
    for number in range(2, 7):
        cross(app, "red", number)
    lock_mode(app, "red").select("Points").run()
    assert "Red 🔒" in [m.label.strip() for m in app.sidebar.metric]
    assert all(checkbox(app, f"red_{n}").disabled for n in range(2, 13))


@pytest.mark.xfail(strict=True, reason='The heading line is `## ⚠️ Penalties")` outside any string, so it is a comment and never renders')
def test_penalties_section_has_a_heading(app):
    assert any(re.fullmatch(r"(---\s*)?##\s*⚠️\s*Penalties", m.value.strip()) for m in app.markdown)
