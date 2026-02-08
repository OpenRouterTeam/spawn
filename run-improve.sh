#!/bin/bash
# Wrapper for Sprite service — always pulls latest before running
cd /home/sprite/spawn
git checkout main 2>/dev/null
git pull --rebase origin main 2>/dev/null
exec bash improve.sh --loop >> /home/sprite/spawn/improve.log 2>&1
