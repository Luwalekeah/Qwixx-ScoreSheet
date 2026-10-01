import streamlit as st

import persistence

APP_NAME = "qwixx"
COLORS = ("red", "yellow", "green", "blue")
LOCK_MODES = ("", "Points", "No Points")
CELLS_PER_ROW = 11  # the numbers 2..12
MIN_CROSSES_TO_LOCK_FOR_POINTS = 5
MAX_PENALTIES = 4
STATE_VERSION = 1


class QwixxScoresheet:
    """Streamlined Qwixx score sheet with lock modes: Points or No Points."""

    def __init__(self):
        self._init_state()
        self._game = persistence.GameSession(APP_NAME)

    def _init_state(self):
        defaults = {
            "crosses": {c: [False] * 11 for c in ["red", "yellow", "green", "blue"]},
            # lock_mode: "", "Points" or "No Points"
            "lock_mode": {c: "" for c in ["red", "yellow", "green", "blue"]},
            "penalty": 0
        }
        if "game" not in st.session_state:
            st.session_state.game = defaults

    def _score(self, n):
        # Triangular scoring: 0,1,3,6,...
        return n * (n + 1) // 2 if n else 0

    def _row_score(self, color):
        cnt = sum(st.session_state.game["crosses"][color])
        # a Points lock counts as if it were another crossed number (per the rules text)
        if st.session_state.game["lock_mode"][color] == "Points":
            return self._score(cnt + 1)
        return self._score(cnt)

    def _can_cross(self, row, idx):
        # disable further crosses once any lock mode chosen
        if st.session_state.game["lock_mode"][row] != "":
            return False
        crosses = st.session_state.game["crosses"][row]
        last = max((i for i, v in enumerate(crosses) if v), default=-1)
        return idx >= last

    def _toggle_cross(self, row, idx):
        st.session_state.game["crosses"][row][idx] ^= True

    def _set_lock_mode(self, row, mode_label):
        # Always allow "No Points" or blank. Only allow "Points" if 5+ crosses.
        cnt = sum(st.session_state.game["crosses"][row])
        if mode_label == "Points":
            if cnt >= 5:
                st.session_state.game["lock_mode"][row] = mode_label
            else:
                st.session_state.game["lock_mode"][row] = ""
        elif mode_label in ["No Points", ""]:
            st.session_state.game["lock_mode"][row] = mode_label

    def _set_penalty(self, idx):
        current = st.session_state.game["penalty"]
        st.session_state.game["penalty"] = idx + 1 if idx >= current else idx

    def render(self):
        self._restore_saved_game()

        # Custom checkbox-label colors
        st.markdown(
            """
            <style>
              .red-row input[type=checkbox] + label, .red-row label[for^=\"red_\"] { color: #b71c1c !important; }
              .yellow-row input[type=checkbox] + label, .yellow-row label[for^=\"yellow_\"] { color: #f9a825 !important; }
              .green-row input[type=checkbox] + label, .green-row label[for^=\"green_\"] { color: #2e7d32 !important; }
              .blue-row input[type=checkbox] + label, .blue-row label[for^=\"blue_\"] { color: #1565c0 !important; }
            </style>
            """,
            unsafe_allow_html=True
        )

        # Sidebar summary
        with st.sidebar:
            st.markdown("## 📊 Summary")
            total = 0
            for color in ["red", "yellow", "green", "blue"]:
                cnt = sum(st.session_state.game["crosses"][color])
                mode = st.session_state.game["lock_mode"][color]
                score = self._row_score(color)
                delta = cnt + (1 if mode == "Points" else 0)
                label = f"{color.title()} {('🔒' if mode else '')}"
                st.metric(label=label, value=score, delta=f"{delta}×")
                total += score
            pen_score = st.session_state.game["penalty"] * -5
            st.metric(label="Penalties", value=pen_score, delta=f"{st.session_state.game['penalty']}×")
            st.markdown(f"### Total: {total + pen_score}")
            st.button("🔄 Reset Game", on_click=self._reset, help="Reset and restart")

        # Main rows
        row_styles = {"red": "#ef9a9a", "yellow": "#fff59d", "green": "#a5d6a7", "blue": "#90caf9"}
        sequences = [
            ("red", range(2,13)),
            ("yellow", range(2,13)),
            ("green", range(12,1,-1)),
            ("blue", range(12,1,-1))
        ]
        for color, nums in sequences:
            st.markdown(
                f'<div class="{color}-row" style="background:{row_styles[color]}; padding:10px; border-radius:8px; margin-bottom:12px">',
                unsafe_allow_html=True
            )
            cols = st.columns(len(nums) + 2)
            for i, n in enumerate(nums):
                with cols[i]:
                    st.checkbox(
                        label=str(n),
                        key=f"{color}_{n}",
                        value=st.session_state.game["crosses"][color][i],
                        disabled=not self._can_cross(color, i),
                        on_change=lambda r=color, idx=i: self._toggle_cross(r, idx)
                    )
            # Lock Mode always enabled
            with cols[-2]:
                choice = st.selectbox(
                    "Lock Mode",
                    ["", "Points", "No Points"],
                    key=f"{color}_mode"
                )
                prev_mode = st.session_state.game["lock_mode"][color]
                self._set_lock_mode(color, st.session_state[f"{color}_mode"])
                # Determine if Points was invalid selection
                invalid = (choice == "Points" and prev_mode == "" and st.session_state.game["lock_mode"][color] == "")
            # Lock indicator and warning
            with cols[-1]:
                if invalid:
                    st.markdown(
                        '<div style="background:#f9a825; color:#000; padding:4px; border-radius:4px;">Need more ✓s to lock for points</div>',
                        unsafe_allow_html=True
                    )
                mode = st.session_state.game["lock_mode"][color]
                text = "Locked" if mode else ""
                bonus = " +1pt" if mode == "Points" else ""
                st.markdown(f"**{text}{bonus}**", unsafe_allow_html=True)
            st.markdown("</div>", unsafe_allow_html=True)

        # Penalty section
        st.markdown("---")
## ⚠️ Penalties")
        cols = st.columns(4)
        for i in range(4):
            with cols[i]:
                st.checkbox(
                    label="🎲❌",
                    key=f"pen_{i}",
                    value=i < st.session_state.game["penalty"],
                    on_change=lambda idx=i: self._set_penalty(idx)
                )

        # Running totals"
        st.markdown("---\n## 📈 Running Totals")
        cols = st.columns(5)
        total_score = 0
        for i, color in enumerate(["red", "yellow", "green", "blue"]):
            cnt = sum(st.session_state.game["crosses"][color])
            mode = st.session_state.game["lock_mode"][color]
            score = self._row_score(color)
            total_score += score
            delta = cnt + (1 if mode == "Points" else 0)
            with cols[i]:
                st.markdown(f'<span style="font-weight:bold; color:{row_styles[color]};">{color.title()} Score</span>', unsafe_allow_html=True)
                st.metric(label=f"{color.title()} score", value=score, delta=f"{delta}×", label_visibility="collapsed")
        pen_score = st.session_state.game["penalty"] * -5
        with cols[4]:
            st.markdown('<span style="font-weight:bold; color:#fff;">Penalty Impact</span>', unsafe_allow_html=True)
            st.metric(label="Penalty impact", value=pen_score, delta=f"{st.session_state.game['penalty']}×", label_visibility="collapsed")

        st.markdown(f"### 🎯 Grand Total: **{total_score + pen_score}**")

        self._autosave_game()
        with st.sidebar:
            self._game.render_status()

    # ── Saved games (optional; see persistence.py) ──────────────────────────────

    def _snapshot(self):
        """The whole sheet as a JSON-able dict."""
        game = st.session_state.game
        return {
            "v": STATE_VERSION,
            "crosses": {c: [bool(x) for x in game["crosses"][c]] for c in COLORS},
            "lock_mode": {c: game["lock_mode"][c] for c in COLORS},
            "penalty": int(game["penalty"]),
        }

    @staticmethod
    def _validated_state(state):
        """Return `state` if it is a well-formed saved Qwixx sheet, else None."""
        try:
            if state.get("v") != STATE_VERSION:
                return None
            crosses, modes, penalty = state["crosses"], state["lock_mode"], state["penalty"]
            if not (isinstance(crosses, dict) and set(crosses) == set(COLORS)):
                return None
            if not (isinstance(modes, dict) and set(modes) == set(COLORS)):
                return None
            for color in COLORS:
                row = crosses[color]
                if not (isinstance(row, list) and len(row) == CELLS_PER_ROW and all(type(x) is bool for x in row)):
                    return None
                if modes[color] not in LOCK_MODES:
                    return None
                if modes[color] == "Points" and sum(row) < MIN_CROSSES_TO_LOCK_FOR_POINTS:
                    return None
            if type(penalty) is not int or not 0 <= penalty <= MAX_PENALTIES:
                return None
        except (AttributeError, KeyError, TypeError):
            return None
        return state

    def _apply_saved_state(self, state):
        """Load a validated saved sheet into session state. Must run before the widgets are drawn."""
        st.session_state.game = {
            "crosses": {c: list(state["crosses"][c]) for c in COLORS},
            "lock_mode": {c: state["lock_mode"][c] for c in COLORS},
            "penalty": state["penalty"],
        }
        for color in COLORS:
            # The lock selectboxes own their value; without this they would start blank and clear the lock.
            st.session_state[f"{color}_mode"] = state["lock_mode"][color]

    def _restore_saved_game(self):
        saved = self._game.restore()
        if saved is None:
            return
        clean = self._validated_state(saved)
        if clean is None:
            self._game.mark_unusable()
            return
        self._apply_saved_state(clean)

    def _autosave_game(self):
        self._game.save_if_changed(self._snapshot())

    def _reset(self):
        """Button callback: detach from the saved game (which stays stored) and start over."""
        persistence.forget_game()
        st.session_state.clear()

if __name__ == "__main__":
    QwixxScoresheet().render()
