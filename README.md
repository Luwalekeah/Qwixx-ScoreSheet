# Qwixx ScoreSheet

A Streamlit score sheet for the Qwixx dice game, with the rules and strategy notes underneath.

## Features

* Four colour rows: red and yellow run 2 → 12, green and blue run 12 → 2. Numbers can only be crossed left to right.
* Lock a row for points (needs 5 or more crosses) or without points. A locked row is frozen.
* Penalties (−5 each, up to 4).
* Sidebar summary and running totals with a grand total, plus a reset button.
* Expanders for the game overview, how to play, scoring, locking, game end, strategy, dice probabilities and a quick reference.

## Usage

```sh
python3 -m venv venv
source venv/bin/activate        # On Windows: venv\Scripts\activate
pip install -r requirements.txt
streamlit run qwixx.py
```

## Dependencies

Pinned in `requirements.txt` (Python **3.12 or newer** is required by NumPy 2.5):

* [Streamlit](https://streamlit.io/) 1.64.0
* [Pandas](https://pandas.pydata.org/) 3.0.6
* [NumPy](https://numpy.org/) 2.5.3 and [PyArrow](https://arrow.apache.org/docs/python/) 25.0.1 (pulled in by Streamlit and Pandas; the app code does not import them directly)

## Tests

The tests drive the real app headlessly with Streamlit's `AppTest`:

```sh
pip install -r requirements-dev.txt
pytest
```
