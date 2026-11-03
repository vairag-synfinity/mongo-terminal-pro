# Connection guide

## Adding a connection

### In the dashboard

`mtp` → **11 Connection Manager** → `a`.

- Toggle **Use connection string** to switch between a URI and host/port fields.
- **Test Connection** opens a temporary client, pings the server and reports version and topology.
  It never changes the active connection.
- **Save** stores the profile. With **Remember password** on, the password goes to the credential
  store; otherwise it is kept in memory for this session only.
- Validation runs before testing or saving: names must be unique, URIs must be well formed,
  `mongodb+srv` hosts cannot carry ports, and warnings are shown for remote servers without TLS or
  disabled certificate validation.

### On the command line

```bash
mtp connections add                                   # fully interactive
mtp connections add --name "Atlas prod" \
  --uri "mongodb+srv://appuser@cluster0.abcde.mongodb.net/" --production --save-password
```

The password is always prompted (or read from `MTP_PASSWORD` in non-interactive use). A URI that
contains a password is rejected on the command line, because arguments are visible in shell history
and process listings.

## Examples

| Scenario                          | URI / fields                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Local server                      | `mongodb://localhost:27017`                                                        |
| Local replica set member (Docker) | `mongodb://localhost:27017/?directConnection=true`                                 |
| Self-hosted with auth             | `mongodb://admin@db.internal:27017/?authSource=admin` (+ password)                 |
| Replica set                       | `mongodb://user@h1:27017,h2:27017,h3:27017/?replicaSet=rs0&authSource=admin`       |
| Atlas                             | `mongodb+srv://user@cluster0.xxxxx.mongodb.net/`                                   |
| Sharded cluster (mongos)          | `mongodb://user@mongos1:27017,mongos2:27017/`                                      |
| TLS with private CA               | `mongodb://user@db:27017/?tls=true` + TLS CA file `/etc/ssl/my-ca.pem`             |
| X.509                             | `mongodb://db:27017/?tls=true&authMechanism=MONGODB-X509` + client certificate PEM |
| AWS IAM                           | `mongodb+srv://cluster0.xxxxx.mongodb.net/?authMechanism=MONGODB-AWS`              |

Passwordless mechanisms (X.509, AWS, Kerberos/GSSAPI, OIDC) never prompt for a password.

## Restricted users

If your user cannot run `listDatabases`, the database list falls back to databases you are
authorised for, and finally to the connection's **Default database**. Commands such as
`serverStatus` (needs `clusterMonitor`) or `$indexStats` are reported as unavailable instead of
failing the whole screen. Mongo Terminal Pro never tries to bypass server permissions.

## MongoDB Compass discovery

Dashboard: Connection Manager → `c`. CLI: `mtp connections discover --compass`.

Locations searched (read-only):

| OS      | Directories                                                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | `%APPDATA%\MongoDB Compass`, `…\MongoDB Compass Readonly`, `…\MongoDB Compass Isolated Edition`, `…\MongoDB Compass Beta`                 |
| macOS   | `~/Library/Application Support/MongoDB Compass*`                                                                                          |
| Linux   | `$XDG_CONFIG_HOME` or `~/.config/MongoDB Compass*`, `~/snap/mongodb-compass/current/.config/…`, `~/.var/app/com.mongodb.Compass/config/…` |

Installation is detected from the executable locations and `AppPreferences/General.json`
(version). Supported formats:

- **Compass 1.39+** — `Connections/<id>.json` with the connection string (without password) and
  `connectionSecrets` encrypted by the operating system. The secrets are not decrypted; the profile
  is imported with "password required" and you enter it on first connect.
- **Older versions** — legacy model files (`hostname`, `port`, `replicaSet` …) are converted.
  Versions that keep connections in Compass's internal IndexedDB cannot be read directly: use
  Compass → _Connections → Export saved connections_ and import the file with
  `mtp connections discover --compass-export file.json`.
- Any plain-text password found in an old file is ignored for safety.

Already-saved connections are marked and skipped; names are de-duplicated (`Name (2)`).

## Environment variables and `.env` files

Dashboard: Connection Manager → `v`. CLI:

```bash
mtp connections discover --dir ~/code/my-api        # .env files of that directory only
mtp connections discover --env                      # current process environment
mtp connections discover --dir . --all --save-passwords
```

Rules:

- You choose the directory and confirm the scan; only `.env`, `.env.local`, `.env.development`,
  `.env.development.local`, `.env.test`, `.env.production`, `.env.production.local` and
  `.env.example` at the top level are read (max 512 KB each). Nothing is executed.
- Variables considered: `MONGODB_URI`, `MONGO_URI`, `MONGODB_URL`, `MONGO_URL`, `DATABASE_URL`,
  `MONGO_CONNECTION_STRING`, `MONGODB_CONNECTION_STRING`, `ME_CONFIG_MONGODB_URL` and any variable
  containing `MONGO` — but only when the value is a `mongodb://` or `mongodb+srv://` URI.
- Values are displayed masked (`mongodb://user:****@host`). Passwords found are only stored when
  you ask for it.

## Ad-hoc connections without saving

```bash
MTP_URI="mongodb://localhost:27017" mtp databases
MTP_URI="mongodb://admin@db:27017/?authSource=admin" MTP_PASSWORD=… mtp status
MTP_URI="…" MTP_PRODUCTION=1 mtp import … --write --confirm MTP_URI
```

## SSH tunnels

Mongo Terminal Pro does not embed an SSH client. Use standard port forwarding — it works the same
on Windows (built-in OpenSSH), macOS and Linux:

```bash
ssh -N -L 27018:db-private-host:27017 user@bastion.example.com
# then connect to: mongodb://localhost:27018/?directConnection=true
```

For replica sets behind a bastion, connect to a single member with `directConnection=true` (the
driver would otherwise try the members' private host names). For TLS through a tunnel, add
`tlsAllowInvalidHostnames` only if the certificate does not cover `localhost`, or forward a host
name that matches the certificate via `/etc/hosts`.

## Managing saved connections

| Action                                    | Dashboard | CLI                                  |
| ----------------------------------------- | --------- | ------------------------------------ |
| Connect                                   | Enter     | `-c <name>` on any command           |
| Edit                                      | `e`       | —                                    |
| Rename                                    | `r`       | `mtp connections rename <old> <new>` |
| Delete (also removes the stored password) | `d`       | `mtp connections remove <name>`      |
| Favorite                                  | `f`       | `mtp connections favorite <name>`    |
| Default                                   | `s`       | `mtp connections default <name>`     |
| Test                                      | `t`       | `mtp connections test [name]`        |
| Disconnect                                | `x`       | —                                    |
