#!/bin/bash
set -e

# cd to script directory
cd "$(dirname "$0")"

sudo ln -sf $(realpath ./miniworld.service) /etc/systemd/system/miniworld.service

sudo systemctl daemon-reload
sudo systemctl enable --now miniworld
sudo systemctl status miniworld
