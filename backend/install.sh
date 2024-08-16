#!/bin/bash
set -e

[ ! -d ".venv" ] && python3 -m venv .venv
. .venv/bin/activate

# Install dependencies
pip install -U "fastapi[standard]" pydantic python-dotenv geopy httpx

# cd to script directory
cd "$(dirname "$0")"

sudo ln -sf $(realpath ./miniworld.service) /etc/systemd/system/miniworld.service

sudo systemctl daemon-reload
sudo systemctl enable --now miniworld
sudo systemctl status miniworld
