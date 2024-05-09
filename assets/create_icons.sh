#!/bin/sh
# uses icon.png as the "root" to generate the other images
set -xe

convert icon.png -resize 512x512 ./adaptive-icon.png
convert icon.png -resize 48x48 ./favicon.png
convert icon.png -resize 1284x2778 -background none -gravity center -extent 1284x2778 splash.png

