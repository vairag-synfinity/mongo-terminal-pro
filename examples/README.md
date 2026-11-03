# Examples

| File                             | What it shows                                                    |
| -------------------------------- | ---------------------------------------------------------------- |
| `sample-data/customers.jsonl`    | JSON Lines with Extended JSON types (ObjectId, Date, Decimal128) |
| `sample-data/customers.csv`      | CSV with nested target fields (`address.city`) and mixed types   |
| `export-active-users.mjs`        | Using the programmatic API to stream a filtered export           |
| `ci-backup.sh` / `ci-backup.ps1` | Non-interactive verified backup from a CI job or scheduled task  |

Try the sample data against a **disposable** database:

```bash
mtp import --db demo --collection customers --file examples/sample-data/customers.jsonl --dry-run
mtp import --db demo --collection customers --file examples/sample-data/customers.jsonl --write
mtp import --db demo --collection customers_csv --file examples/sample-data/customers.csv --write
mtp query --db demo --collection customers --filter '{ "address.city": "Pune" }'
```
