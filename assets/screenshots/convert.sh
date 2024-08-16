#!/bin/sh
set -ex

for slug in grant login map; do
  convert iphone_se_${slug}_screen.png -resize 1242x2208! iphone_se_${slug}_screen_55.png
done

