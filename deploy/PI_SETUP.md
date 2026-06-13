# Raspberry Pi — World Cup live data server (one-time setup)

The Pi scrapes Sportsbet + ESPN and serves the data over HTTPS. It only **pulls**
this public repo and **serves** data — it never pushes, so there's no GitHub
token to manage. Copy-paste these on the Pi.

## 1. Expose the Pi (Tailscale Funnel — no domain, no port-forwarding)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                       # log in via the printed URL
sudo tailscale funnel 8090              # public HTTPS -> localhost:8090
tailscale funnel status                 # note the https://<pi>.<tailnet>.ts.net URL
```

## 2. Get the code + a data dir + webhook secret
```bash
cd ~
git clone https://github.com/pavlova-del/worldcupbracket.git
mkdir -p ~/wc-data
echo "WEBHOOK_SECRET=$(openssl rand -hex 20)" > ~/wc-data/.env
cat ~/wc-data/.env                      # copy this line — send the secret to me
```

## 3. Install + start the service (runs on boot, restarts on crash)
```bash
sudo tee /etc/systemd/system/worldcup.service >/dev/null <<EOF
[Unit]
Description=World Cup live data server
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/worldcupbracket
EnvironmentFile=$HOME/wc-data/.env
Environment=WC_DATA_DIR=$HOME/wc-data
Environment=WC_PORT=8090
ExecStart=/usr/bin/python3 $HOME/worldcupbracket/pi_server.py
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now worldcup
systemctl status worldcup --no-pager
```

## 4. Test
```bash
curl localhost:8090/health                              # -> ok
sleep 65 && curl -s localhost:8090/data/odds_latest.json | head -c 120   # JSON after first scrape
curl -s https://<pi>.<tailnet>.ts.net/health            # from the public URL
```

## 5. Send me
- the Funnel URL: `https://<pi>.<tailnet>.ts.net`
- the `WEBHOOK_SECRET` from `~/wc-data/.env`

I'll point both sites at it and register the GitHub push-webhook (push to deploy).

## Handy
- logs: `journalctl -u worldcup -f`
- restart: `sudo systemctl restart worldcup`
- the deploy webhook (once I set it up): a push to GitHub → POST `…/deploy` →
  the Pi `git pull`s and re-execs itself only if `pi_server.py` changed.
