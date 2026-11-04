import React from 'react';
import type { Route } from '../context.js';
import { AggregationScreen } from './aggregation-screen.js';
import { BackupScreen } from './backup-screen.js';
import { CollectionListScreen } from './collection-list-screen.js';
import { CollectionScreen } from './collection-screen.js';
import { ConnectionScreen } from './connection-screen.js';
import { Dashboard } from './dashboard.js';
import { DatabaseScreen } from './database-screen.js';
import { DocumentScreen } from './document-screen.js';
import { ExportScreen } from './export-screen.js';
import { HelpScreen } from './help-screen.js';
import { ImportScreen } from './import-screen.js';
import { IndexScreen } from './index-screen.js';
import { MonitoringScreen } from './monitoring-screen.js';
import { PickerScreen } from './picker-screen.js';
import { QueryScreen } from './query-screen.js';
import { SettingsScreen } from './settings-screen.js';
import { WorkspaceScreen } from './workspace-screen.js';
import { CopyScreen } from './copy-screen.js';

/** Maps a route to its screen. The route key forces a fresh component per navigation. */
export function renderScreen(route: Route): React.ReactNode {
  // Params are validated by each screen; the router only carries them.
  const p = route.params as never;
  switch (route.screen) {
    case 'dashboard':
      return <Dashboard key={route.key} />;
    case 'connections':
      return <ConnectionScreen key={route.key} params={p} />;
    case 'databases':
      return <DatabaseScreen key={route.key} />;
    case 'collections':
      return <CollectionListScreen key={route.key} params={p} />;
    case 'collection':
      return <CollectionScreen key={route.key} params={p} />;
    case 'documents':
      return <DocumentScreen key={route.key} params={p} />;
    case 'query':
      return <QueryScreen key={route.key} params={p} />;
    case 'aggregation':
      return <AggregationScreen key={route.key} params={p} />;
    case 'import':
      return <ImportScreen key={route.key} params={p} />;
    case 'export':
      return <ExportScreen key={route.key} params={p} />;
    case 'backup':
      return <BackupScreen key={route.key} params={p} />;
    case 'indexes':
      return <IndexScreen key={route.key} params={p} />;
    case 'monitoring':
      return <MonitoringScreen key={route.key} />;
    case 'settings':
      return <SettingsScreen key={route.key} />;
    case 'help':
      return <HelpScreen key={route.key} />;
    case 'copy':
      return <CopyScreen key={route.key} params={p} />;
    case 'workspace':
      return <WorkspaceScreen key={route.key} />;
    case 'picker':
      return <PickerScreen key={route.key} params={p} />;
  }
}
