"""Inspect or clear the conversation -> CLI session map.

Run via: scripts/sessions.sh [list|clear]
"""
import os
import sqlite3
import sys
import time

db_path = os.path.join(os.environ.get("CLI_STATE_DIR", "/state"), "sessions.db")
if not os.path.exists(db_path):
    print("no sessions yet")
    sys.exit(0)
db = sqlite3.connect(db_path)
cmd = (sys.argv[1:] or ["list"])[0]

if cmd == "clear":
    n = db.execute("DELETE FROM sessions").rowcount
    db.commit()
    print(f"cleared {n} entries (next turn of each chat replays its history into a new CLI session)")
elif cmd == "list":
    rows = db.execute(
        "SELECT scope, session_id, MAX(turns), MAX(updated) FROM sessions "
        "GROUP BY session_id ORDER BY MAX(updated) DESC LIMIT 30"
    ).fetchall()
    print(f"{'scope':<28} {'session':<38} {'msgs':>4}  last used")
    for scope, sid, turns, updated in rows:
        print(f"{scope:<28} {sid:<38} {turns:>4}  {time.strftime('%Y-%m-%d %H:%M', time.localtime(updated))}")
else:
    sys.exit("usage: sessions.py [list|clear]")
