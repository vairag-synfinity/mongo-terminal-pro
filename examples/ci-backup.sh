#!/usr/bin/env sh
# Verified nightly backup (Linux/macOS). Exit code 2 means the backup did not verify.
# Store the connection once:  MTP_PASSWORD=... mtp connections add --name "Prod" --uri "mongodb://backup@db:27017/?authSource=admin" --save-password
set -eu
mtp backup -c "Prod" --db "${1:-shop}" --gzip --out "${BACKUP_DIR:-/var/backups/mongo}"
mtp backups --json | head -c 2000
