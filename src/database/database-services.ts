import type { MongoClient } from 'mongodb';
import type { Settings } from '../config/defaults.js';
import type { Logger } from '../core/logger.js';
import type { PermissionManager } from '../security/permission-manager.js';
import { AggregationManager } from './aggregation-manager.js';
import { CollectionManager } from './collection-manager.js';
import { DatabaseManager } from './database-manager.js';
import { DocumentManager } from './document-manager.js';
import { IndexManager } from './index-manager.js';
import { QueryManager } from './query-manager.js';
import { SchemaAnalyzer } from './schema-analyzer.js';
import { StatisticsManager } from './statistics-manager.js';

/** All database services bound to one MongoClient (one connection pool). */
export class DatabaseServices {
  readonly databases: DatabaseManager;
  readonly collections: CollectionManager;
  readonly documents: DocumentManager;
  readonly queries: QueryManager;
  readonly aggregations: AggregationManager;
  readonly indexes: IndexManager;
  readonly schema: SchemaAnalyzer;
  readonly statistics: StatisticsManager;

  constructor(
    readonly client: MongoClient,
    readonly permissions: PermissionManager,
    readonly settings: () => Promise<Settings>,
    readonly logger: Logger,
    fallbackDatabase?: string,
  ) {
    this.databases = new DatabaseManager(client, permissions, fallbackDatabase);
    this.collections = new CollectionManager(client, permissions);
    this.documents = new DocumentManager(client, permissions);
    this.queries = new QueryManager(client, permissions);
    this.aggregations = new AggregationManager(client, permissions);
    this.indexes = new IndexManager(client, permissions);
    this.schema = new SchemaAnalyzer(client);
    this.statistics = new StatisticsManager(client);
  }
}
