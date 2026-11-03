# Verified nightly backup (Windows Task Scheduler). Exit code 2 means the backup did not verify.
param([string]$Database = "shop", [string]$Out = "D:\Backups\Mongo")
mtp backup -c "Prod" --db $Database --gzip --out $Out
if ($LASTEXITCODE -ne 0) { Write-Error "Backup failed with exit code $LASTEXITCODE"; exit $LASTEXITCODE }
