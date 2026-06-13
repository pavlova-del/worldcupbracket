#!/usr/bin/env python3
"""World Cup live-data server (runs on the always-on Raspberry Pi).

- Scrapes Sportsbet + ESPN every ~60s as subprocesses (so a `git pull` picks up
  new scraper code on the next cycle) into WC_DATA_DIR, which sits OUTSIDE the
  repo so pulls never conflict.
- Serves GET /data/<file>.json with permissive CORS, so the GitHub Pages
  front-ends fetch live odds/results/fixtures straight from the Pi.
- POST /deploy is the GitHub push webhook: it verifies the HMAC signature, runs
  `git pull`, and re-execs itself only if pi_server.py changed.

Stdlib only. Managed by systemd — see deploy/PI_SETUP.md.
"""

import hashlib
import hmac
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("WC_DATA_DIR", os.path.expanduser("~/wc-data"))
PORT = int(os.environ.get("WC_PORT", "8090"))
SECRET = os.environ.get("WEBHOOK_SECRET", "").encode()
SCRAPE_EVERY = int(os.environ.get("WC_SCRAPE_SECS", "60"))
SERVE = {"odds_latest.json", "odds_prev.json", "odds_history.json", "fixtures.json", "results.json"}


def log(*a):
    print(time.strftime("%F %T"), *a, flush=True)


def run_scrapers():
    env = {**os.environ, "WC_DATA_DIR": DATA_DIR}
    for script in ("scrape_snapshot.py", "scrape_results.py"):
        try:
            subprocess.run([sys.executable, script], cwd=REPO_DIR, env=env, timeout=120,
                           check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as e:  # noqa: BLE001
            log("scrape error", script, e)


def scrape_loop():
    os.makedirs(DATA_DIR, exist_ok=True)
    while True:
        run_scrapers()
        time.sleep(SCRAPE_EVERY)


def git_pull_and_maybe_restart():
    try:
        before = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO_DIR).strip()
        subprocess.run(["git", "pull", "--ff-only", "--quiet"], cwd=REPO_DIR, timeout=60, check=False)
        after = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO_DIR).strip()
        if before == after:
            log("deploy: already up to date")
            return
        changed = subprocess.check_output(["git", "diff", "--name-only", before, after], cwd=REPO_DIR).decode()
        log(f"deployed {before[:7].decode()} -> {after[:7].decode()}")
        if "pi_server.py" in changed:
            log("server code changed -> re-exec")
            threading.Timer(0.5, lambda: os.execv(sys.executable, [sys.executable] + sys.argv)).start()
    except Exception as e:  # noqa: BLE001
        log("deploy error", e)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")

    def do_OPTIONS(self):
        self.send_response(204); self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*"); self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self.send_response(200); self._cors()
            self.send_header("Content-Type", "text/plain"); self.end_headers()
            self.wfile.write(b"ok"); return
        if path.startswith("/data/"):
            name = path.rsplit("/", 1)[-1]
            if name in SERVE:
                fp = os.path.join(DATA_DIR, name)
                if os.path.isfile(fp):
                    with open(fp, "rb") as f:
                        body = f.read()
                    self.send_response(200); self._cors()
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Cache-Control", "no-store"); self.end_headers()
                    self.wfile.write(body); return
        self.send_response(404); self._cors(); self.end_headers()

    def do_POST(self):
        if not self.path.startswith("/deploy"):
            self.send_response(404); self._cors(); self.end_headers(); return
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length else b""
        sig = self.headers.get("X-Hub-Signature-256", "")
        good = bool(SECRET) and sig.startswith("sha256=") and hmac.compare_digest(
            sig.split("=", 1)[1], hmac.new(SECRET, body, hashlib.sha256).hexdigest())
        if not good:
            self.send_response(401); self._cors(); self.end_headers(); return
        self.send_response(202); self._cors(); self.end_headers(); self.wfile.write(b"deploying")
        threading.Thread(target=git_pull_and_maybe_restart, daemon=True).start()


if __name__ == "__main__":
    log(f"start repo={REPO_DIR} data={DATA_DIR} port={PORT} secret={'set' if SECRET else 'MISSING'}")
    threading.Thread(target=scrape_loop, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
