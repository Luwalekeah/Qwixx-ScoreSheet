# qwixx.py
import streamlit as st
from expander import QwixxExpanders
from scoresheet import QwixxScoresheet

def main():
    """Main application function."""
    # ── 1) Page Config ──────────────────────────────────────────────────────────
    st.set_page_config(
        page_title="Qwixx Score Sheet",
        page_icon="🎲",
        layout="wide",
        initial_sidebar_state="collapsed"
    )
    
    # ── 2) Banner (if desired) ─────────────────────────────────────────────────
    if "first_time" not in st.session_state:
        welcome_banner = """
        <div style="
            background-color: #FFE4B5;
            padding: 12px;
            border-radius: 5px;
            margin-bottom: 20px;
            text-align: center;
        ">
            <span style="font-weight:bold; color:#8B4513; font-size:16px;">
                Game Instructions &amp; Scoring Rules can be found at the bottom of the app.
            </span>
        </div>
        """
        st.markdown(welcome_banner, unsafe_allow_html=True)

    
    # ── 3) Title ─────────────────────────────────────────────────────────────────
    st.markdown(
        """
        <h1 style="text-align:center;">🎲 Qwixx Score Sheet</h1>
        <p style="text-align:center; color:#555;">
            The fast-paced dice game where every roll counts!
        </p>
        """,
        unsafe_allow_html=True,
    )
    

    
    # ── 4) Score Sheet ───────────────────────────────────────────────────────────
    scoresheet = QwixxScoresheet()
    scoresheet.render()
    
    # ── 5) Divider Before Expanders ─────────────────────────────────────────────
    st.markdown("---")
    
    # ── 6) Expanders at Bottom ──────────────────────────────────────────────────
    expanders = QwixxExpanders()
    expanders.render_all_expanders()
    
    # ── 7) Footer Copyright ─────────────────────────────────────────────────────
    st.markdown(
        """
        <div style="display: flex; justify-content: center; text-align: center;">
            <p>© 2025 TechTales w/ Luwah.
            <a href="https://github.com/Luwalekeah" target="_blank">GitHub</a></p>
        </div>
        """,
        unsafe_allow_html=True,
    )

if __name__ == "__main__":
    main()