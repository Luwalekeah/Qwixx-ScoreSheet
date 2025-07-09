import streamlit as st

class QwixxExpanders:
    """Class to handle all expandable information sections for Qwixx app."""
    
    def __init__(self):
        pass
    
    def render_game_overview(self):
        """Render basic game overview."""
        with st.expander("🎯 Game Overview"):
            st.markdown("""
            ### Qwixx Quick Facts
            
            **Players:** 2 to 5 • **Ages:** 8 to adult • **Time:** 15 minutes
            
            **Object:** Score the most points by crossing off numbers in colored rows
            
            **Game Components:**
            - 6 dice: 4 colored (red, yellow, green, blue) + 2 white
            - Score pads with 4 colored number rows
            - Each player gets their own score sheet
            
            **The Rows:**
            - **Red & Yellow:** Numbers 2-12 (left to right)
            - **Green & Blue:** Numbers 12-2 (right to left)
            - Must cross off numbers from left to right in each row
            """)
    
    def render_gameplay_rules(self):
        """Render core gameplay rules."""
        with st.expander("🎮 How to Play"):
            st.markdown("""
            ### Basic Gameplay
            
            **Each Turn:**
            1. Active player rolls all 6 dice
            2. **Everyone can use:** Sum of both white dice
            3. **Active player only:** Can also use one white + one colored die
            4. Cross off the corresponding number in the matching colored row
            
            **Important Rules:**
            - Numbers must be crossed off from **left to right** in each row
            - You can skip numbers, but can't go back to earlier numbers
            - You don't have to cross off anything if you don't want to
            
            **Failed Throws:**
            - If you can't or don't want to cross off any numbers, mark a penalty box
            - 4 penalty marks = game ends immediately
            """)
    
    def render_scoring_rules(self):
        """Render scoring system."""
        with st.expander("📊 Scoring System"):
            st.markdown("""
            ### How Scoring Works
            
            **Points per Row:**
            - 1 crossed number = 1 point
            - 2 crossed numbers = 3 points
            - 3 crossed numbers = 6 points
            - 4 crossed numbers = 10 points
            - 5 crossed numbers = 15 points
            - 6 crossed numbers = 21 points
            - 7 crossed numbers = 28 points
            - 8 crossed numbers = 36 points
            - 9 crossed numbers = 45 points
            - 10 crossed numbers = 55 points
            - 11 crossed numbers = 66 points
            - 12 crossed numbers = 78 points
            
            **Penalties:**
            - Each failed throw = -5 points
            
            **Final Score:** Add all 4 colored rows, subtract penalties
            """)
    
    def render_locking_rules(self):
        """Render row locking mechanics."""
        with st.expander("🔒 Locking Rows"):
            st.markdown("""
            ### How to Lock a Row
            
            **Requirements:**
            - Must have at least 5 numbers crossed off in the row
            - Must cross off the rightmost number (12 for red/yellow, 2 for green/blue)
            - Can only lock using a colored die (not white dice sum)
            
            **What Happens When Locked:**
            - Draw an X in the lock symbol at the end of the row
            - Remove that colored die from the game for all players
            - No one can cross off more numbers in that row
            - You get points for the lock symbol as if it's another crossed number
            
            **Strategic Importance:**
            - Locking denies other players access to that color
            - Consider timing - lock too early and you limit your own scoring
            - Lock too late and someone else might lock it first
            """)
    
    def render_game_end_rules(self):
        """Render game ending conditions."""
        with st.expander("🏁 Game End Conditions"):
            st.markdown("""
            ### How the Game Ends
            
            **The game ends immediately when:**
            1. **Any player gets 4 penalty marks** (failed throws)
            2. **Two or more colored rows are locked**
            
            **Scoring at Game End:**
            - Count points from each colored row
            - Subtract 5 points for each penalty mark
            - Player with the highest total wins
            
            **Tie Breaker:**
            - Player with fewer penalty marks wins
            - If still tied, player with most numbers in a single row wins
            """)
    
    def render_strategy_tips(self):
        """Render strategy tips and advanced play."""
        with st.expander("⚡ Strategy Tips"):
            st.markdown("""
            ### Strategic Considerations
            
            **Early Game:**
            - Focus on the middle numbers (6-8) - they come up most often
            - Don't rush to cross off numbers - wait for good opportunities
            - Consider which rows other players are working on
            
            **Mid Game:**
            - Start thinking about which rows you can realistically complete
            - Watch for locking opportunities (need 5+ numbers crossed)
            - Balance between advancing your own rows and blocking others
            
            **Late Game:**
            - Focus on your strongest rows
            - Consider defensive locking to prevent others from scoring
            - Be careful about penalty marks - they can end the game
            
            **Advanced Tips:**
            - High numbers (10-12) and low numbers (2-4) are harder to get
            - Green and blue rows (12→2) often score fewer points
            - Sometimes it's better to take a penalty than cross off a bad number
            """)
    
    def render_dice_probabilities(self):
        """Render dice probability reference."""
        with st.expander("🎲 Dice Probabilities"):
            st.markdown("""
            ### White Dice Combinations
            
            **Most Common Sums (2 white dice):**
            - **7** (6 ways): 1+6, 2+5, 3+4, 4+3, 5+2, 6+1
            - **6 & 8** (5 ways each): 6→1+5,2+4,3+3,4+2,5+1 | 8→2+6,3+5,4+4,5+3,6+2
            - **5 & 9** (4 ways each): 5→1+4,2+3,3+2,4+1 | 9→3+6,4+5,5+4,6+3
            
            **Less Common Sums:**
            - **4 & 10** (3 ways each): 4→1+3,2+2,3+1 | 10→4+6,5+5,6+4
            - **3 & 11** (2 ways each): 3→1+2,2+1 | 11→5+6,6+5
            - **2 & 12** (1 way each): 2→1+1 | 12→6+6
            
            **Strategy Insight:**
            - Numbers 6, 7, 8 appear most frequently
            - Numbers 2, 3, 11, 12 are rare - don't wait for them
            - Plan your crosses based on probability
            """)
    
    def render_quick_reference(self):
        """Render quick reference for scoring."""
        with st.expander("📝 Quick Reference"):
            st.markdown("### Scoring Cheat Sheet")
            
            col1, col2 = st.columns(2)
            
            with col1:
                st.markdown("""
                **Crosses → Points:**
                - 1 = 1 point
                - 2 = 3 points  
                - 3 = 6 points
                - 4 = 10 points
                - 5 = 15 points
                - 6 = 21 points
                """)
            
            with col2:
                st.markdown("""
                **More Crosses → Points:**
                - 7 = 28 points
                - 8 = 36 points
                - 9 = 45 points
                - 10 = 55 points
                - 11 = 66 points
                - 12 = 78 points
                """)
            
            st.markdown("---")
            st.markdown("""
            **Quick Reminders:**
            - Cross left to right only
            - Need 5+ crosses to lock a row
            - 4 penalties = game over
            - 2 locked rows = game over
            - Each penalty = -5 points
            """)
    
    def render_all_expanders(self):
        """Render all expander sections in logical order."""
        # Game information sections
        self.render_game_overview()
        self.render_gameplay_rules()
        self.render_scoring_rules()
        self.render_locking_rules()
        self.render_game_end_rules()
        
        # Strategy and reference materials
        self.render_strategy_tips()
        self.render_dice_probabilities()
        self.render_quick_reference()