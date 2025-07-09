import streamlit as st

class QwixxScoresheet:
    """Streamlined Qwixx score sheet with lock modes: Points or No Points."""

    def __init__(self):
        self._init_state()

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
        base = self._score(cnt)
        # bonus only if Points lock selected
        if st.session_state.game["lock_mode"][color] == "Points":
            return base + 1
        return base

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
            st.button("🔄 Reset Game", on_click=lambda: st.session_state.clear(), help="Reset and restart")

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
                st.metric(label="", value=score, delta=f"{delta}×")
        pen_score = st.session_state.game["penalty"] * -5
        with cols[4]:
            st.markdown('<span style="font-weight:bold; color:#fff;">Penalty Impact</span>', unsafe_allow_html=True)
            st.metric(label="", value=pen_score, delta=f"{st.session_state.game['penalty']}×")

        st.markdown(f"### 🎯 Grand Total: **{total_score + pen_score}**")

if __name__ == "__main__":
    QwixxScoresheet().render()
