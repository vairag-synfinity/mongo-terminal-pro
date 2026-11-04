# Import and export

Both directions stream data: files are read and written incrementally and documents are written in
bounded batches, so multi-gigabyte files never need to fit in memory.

## Formats

| Format                    | Import                                      | Export                 | Notes                                                    |
| ------------------------- | ------------------------------------------- | ---------------------- | -------------------------------------------------------- |
| JSON array `[ {…}, {…} ]` | yes                                         | yes (`--layout array`) | Extended JSON wrappers are understood                    |
| JSON Lines / NDJSON       | yes (`.jsonl`, `.ndjson`)                   | yes (`--layout jsonl`) | One document per line; a bad line is reported on its own |
| Concatenated JSON objects | yes                                         | —                      | e.g. legacy `mongoexport` output                         |
| CSV                       | yes, with field mapping                     | yes                    | Header row required on import                            |
| BSON                      | yes (`.bson`, mongodump files)              | yes                    | Raw BSON, lossless                                       |
| gzip                      | yes (any of the above, detected by content) | —                      |                                                          |

## Extended JSON vs ordinary JSON

MongoDB documents contain types JSON does not have (ObjectId, Date, Decimal128, 64-bit integers,
binary data …). Extended JSON represents them with wrapper objects:

```json
{ "_id": { "$oid": "65a0f1c2e4b0a1b2c3d4e5f6" }, "created": { "$date": "2024-01-01T00:00:00Z" } }
```

| Mode                                | Use when                         | Types preserved                                                                                                                                                                                   |
| ----------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Relaxed Extended JSON** (default) | Readable files you may re-import | ObjectId, Date, Decimal128, Binary, Timestamp, RegExp. Numbers are plain JSON numbers (int/long/double not distinguished); longs beyond ±2^53 stay `{"$numberLong": "…"}` so no precision is lost |
| **Canonical Extended JSON**         | Exact round trips / migrations   | Everything, including int vs long vs double                                                                                                                                                       |
| **Plain JSON**                      | Feeding other tools              | Nothing: ObjectIds and dates become strings, Decimal128/Long become strings or numbers                                                                                                            |
| **BSON**                            | Exact copies, mongorestore       | Everything (server bytes are streamed unchanged)                                                                                                                                                  |

## Export

Dashboard: **7 Export Data** (or `x` in the document browser to export the current filter/sort).

```bash
mtp export --db shop --collection orders --format json --out orders.json
mtp export --db shop --collection orders --format json --layout jsonl --json-mode canonical --out orders.jsonl
mtp export --db shop --collection orders --format csv \
  --fields _id,customer.name,total,createdAt --filter '{ status: "paid" }' --sort '{ createdAt: -1 }' \
  --limit 10000 --out paid.csv
mtp export --db shop --collection orders --format bson --out orders.bson
mtp export --db shop --format json --out ./shop-export            # every collection → one file each
mtp export --db shop --collection orders --engine tools --format json --out orders.json   # via mongoexport
```

Options: `--filter`, `--sort`, `--fields` (CSV columns or projection), `--limit`, `--batch-size`,
`--json-mode relaxed|canonical|plain`, `--layout array|jsonl`, `--overwrite`. Without `--out`
files go to the exports folder with a timestamped name.

Behaviour:

- **Path validation**: existing files are never overwritten without `--overwrite` (or the toggle in
  the dashboard); system directories are refused; missing parent folders are created.
- Data is written to `<file>.partial` and renamed only after the export completes. Cancelling
  (Esc in the dashboard) removes the partial file.
- CSV columns default to the fields found in the first 100 matching documents; nested objects use
  dot notation (`address.city`); arrays and sub-documents are written as Extended JSON text.
- Database exports skip `system.*` collections and views (export a view's source collection
  instead, or run the view's pipeline in the Aggregation Builder).
- The summary shows document count, file size, location and duration.

## Import

Dashboard: **6 Import Data** — choose a file (type/paste a path, drag a file onto the terminal, or
**Browse…** for the built-in file picker), the target database and collection (created if needed),
preview the first records, adjust CSV mapping, set options, then **Dry run** or **Import**.

```bash
mtp import --db shop --collection customers --file customers.json --dry-run
mtp import --db shop --collection customers --file customers.json --write
mtp import --db shop --collection customers --file customers.csv --write --delimiter ';'
mtp import --db shop --collection customers --file dump/shop/customers.bson --write
mtp import --db shop --collection customers --file updates.jsonl --write --mode upsert --upsert-fields email
mtp import --db shop --collection customers --file big.jsonl.gz --write --duplicates skip --unordered --batch-size 5000
```

### Safety rules

1. **Write access must be explicit**: `--write` on the CLI, `W` in the dashboard. Production
   connections also need the connection name (`--confirm "<name>"` non-interactively).
2. **Validate first**: the whole file is read and validated before the first write (disable with
   `--no-validate-first`). If any record is invalid nothing is written — unless you choose
   `--skip-invalid`.
3. **Never silently overwrite**: insert mode never modifies existing documents. A duplicate `_id`
   (or unique index key) either stops the import (`--duplicates abort`, default) or is counted and
   skipped (`--duplicates skip`). Already-written batches stay written and are reported.
4. **Upsert is opt-in** (`--mode upsert`): documents matching `--upsert-fields` (default `_id`) are
   replaced; it is treated as a destructive operation and confirmed.

Validation checks: the value is an object, field names have no null bytes, no top-level `$`
fields, nesting depth ≤ 100, size ≤ 16 MB, upsert key fields are present, and the record parses.

### CSV mapping and types

| Type                                               | Behaviour                                                                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auto (default)                                     | `true`/`false` → boolean, integers → int (leading zeros stay strings), decimals → double, full ISO date-times → Date, `null` → null, anything else → string |
| string, number, int, boolean, date, objectId, json | Explicit conversion; failures are validation errors                                                                                                         |
| skip                                               | Column not imported                                                                                                                                         |

Target names may use dots to build nested documents (`address.city`). Empty cells are omitted by
default; in the dashboard the _CSV empty cells_ option can store them as `null` or `""` instead.
On the CLI, CSV columns use automatic type inference (`--delimiter` sets the separator).

### Results

The summary shows records read, valid/invalid, inserted, upserted/matched/modified, skipped
duplicates, failed writes and duration. With `--error-report errors.jsonl` (enabled by default in
the dashboard) every problem is written as one JSON line with its record number and location
(line number or byte offset).

## Using the official tools instead

`--engine tools` delegates a single-collection JSON/CSV import or export to `mongoimport` /
`mongoexport`, passing credentials through a temporary private config file. The built-in engine is
the default because it validates before writing and preserves types consistently.

## Whole databases and folders

- **Export all databases:** `mtp export --all-databases --out ./all/` (dashboard: `X` in the tree, or
  Export → Scope → ALL databases) writes `./all/<database>/<collection>.<ext>`; system databases
  are skipped.
- **Import a folder:** `mtp import --dir ./shop/ --db shop --write` imports every `.json`, `.jsonl`,
  `.csv` or `.bson` file as a collection named after the file (`users.json` → `users`; mongodump
  `*.metadata.json` files are ignored). `--all-databases` treats each sub-folder as a database.
  Every file is validated first; if any record is invalid nothing is written (unless
  `--skip-invalid`). Empty files still create empty collections.
- **Copy without files:** `mtp copy` copies collections directly between databases or connections
  (see [commands.md](commands.md#copy)).
