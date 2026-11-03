import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { ConnectionProfileSchema, type ConnectionProfile } from '../../src/connection/connection-types.js';
import { isLocalUri, stripCredentials } from '../../src/connection/manual-connection.js';

/**
 * Integration tests run only against a disposable MongoDB given by MTP_TEST_MONGODB_URI, e.g.
 *   docker run -d --name mtp-test -p 27099:27099 mongo:7.0 mongod --replSet rs0 --port 27099 --bind_ip_all
 *   MTP_TEST_MONGODB_URI="mongodb://localhost:27099/?directConnection=true" npm run test:integration
 *
 * Safety: non-local hosts are refused unless MTP_TEST_ALLOW_REMOTE=1, and every test file works in
 * its own randomly named database (mtp_it_*) which is dropped afterwards. Nothing else is touched.
 */
export const TEST_URI = process.env.MTP_TEST_MONGODB_URI;

export function integrationEnabled(): boolean {
  if (!TEST_URI) return false;
  if (!isLocalUri(TEST_URI) && process.env.MTP_TEST_ALLOW_REMOTE !== '1') {
    throw new Error(
      'Refusing to run destructive integration tests against a non-local MongoDB. Set MTP_TEST_ALLOW_REMOTE=1 if this is a disposable server.',
    );
  }
  return true;
}

export function uniqueDbName(label: string): string {
  return `mtp_it_${label}_${randomBytes(3).toString('hex')}`;
}

export async function adminClient(): Promise<MongoClient> {
  const client = new MongoClient(TEST_URI as string, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  return client;
}

export async function dropTestDatabases(client: MongoClient, names: string[]): Promise<void> {
  for (const name of names) {
    if (!name.startsWith('mtp_it_')) throw new Error(`Refusing to drop non-test database ${name}`);
    await client
      .db(name)
      .dropDatabase()
      .catch(() => undefined);
  }
}

export function testProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  const n = stripCredentials(TEST_URI as string);
  const now = new Date().toISOString();
  return ConnectionProfileSchema.parse({
    id: `it-${randomBytes(4).toString('hex')}`,
    name: 'Integration',
    uri: n.uri,
    username: n.username,
    authSource: n.authSource,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

export const TEST_PASSWORD = TEST_URI ? stripCredentials(TEST_URI).password : undefined;
