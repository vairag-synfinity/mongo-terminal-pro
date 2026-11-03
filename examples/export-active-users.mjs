// Stream all active users of a collection to a JSON Lines file using the programmatic API.
// Usage: MTP_URI="mongodb://localhost:27017" [MTP_PASSWORD=...] node export-active-users.mjs shop users out.jsonl
import { Application, ConnectionProfileSchema, ExportManager, stripCredentials } from 'mongo-terminal-pro';

const [db = 'shop', collection = 'users', output = 'active-users.jsonl'] = process.argv.slice(2);
if (!process.env.MTP_URI) throw new Error('Set MTP_URI (put the password in MTP_PASSWORD, not in the URI)');

const { uri, username, password, authSource } = stripCredentials(process.env.MTP_URI);
const now = new Date().toISOString();
// readOnlyLocked: this script can never write, whatever happens.
const profile = ConnectionProfileSchema.parse({
  id: 'example',
  name: 'example',
  uri,
  username,
  authSource,
  readOnlyLocked: true,
  createdAt: now,
  updatedAt: now,
});

const app = await Application.create({ logging: false });
try {
  await app.connect(profile, process.env.MTP_PASSWORD ?? password);
  const summary = await new ExportManager(app.connectionManager.getClient()).run({
    database: db,
    collection,
    format: 'json',
    jsonLayout: 'jsonl',
    filter: { status: 'active' },
    output,
    batchSize: 1000,
    onProgress: (p) => process.stderr.write(`\r${p.processed} documents`),
  });
  console.error(`\nExported ${summary.totalDocuments} documents to ${summary.files[0]?.path}`);
} finally {
  await app.shutdown();
}
