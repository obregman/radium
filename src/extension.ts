import * as vscode from 'vscode';
import * as path from 'path';
import { GraphStore } from './store/schema';
import { Indexer } from './indexer/indexer';
import { LLMOrchestrator, LLMPlan } from './orchestrator/llm-orchestrator';
import { SessionsTreeProvider, CodeSlicesTreeProvider, IssuesTreeProvider } from './views/sessions-tree';
import { MapPanel } from './views/map-panel';
import { GitDiffTracker } from './git/git-diff-tracker';
import { RadiumConfigLoader } from './config/radium-config';

let store: GraphStore;
let indexer: Indexer;
let orchestrator: LLMOrchestrator;
let gitDiffTracker: GitDiffTracker;
let sessionsTreeProvider: SessionsTreeProvider;
let codeSlicesTreeProvider: CodeSlicesTreeProvider;
let issuesTreeProvider: IssuesTreeProvider;
let configLoader: RadiumConfigLoader;

export async function activate(context: vscode.ExtensionContext) {
  try {
    console.log('Radium extension is now active');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showWarningMessage('No workspace folder open. Radium requires a workspace.');
      // Still register commands so they can be called later
      registerCommands(context);
      return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const dbPath = path.join(context.globalStorageUri.fsPath, 'radium.db');

    // Ensure storage directory exists
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);

    // Initialize store
    store = new GraphStore(dbPath);
    await store.init();

    // Initialize config loader
    configLoader = new RadiumConfigLoader(workspaceRoot);
    configLoader.load();

    // Initialize indexer
    indexer = new Indexer(store, workspaceRoot);
    
    // Initialize orchestrator
    orchestrator = new LLMOrchestrator(store, workspaceRoot);

    // Initialize git diff tracker
    gitDiffTracker = new GitDiffTracker(store, workspaceRoot);

    // Initialize tree providers
    sessionsTreeProvider = new SessionsTreeProvider(store);
    codeSlicesTreeProvider = new CodeSlicesTreeProvider(store, workspaceRoot);
    issuesTreeProvider = new IssuesTreeProvider(store);

    // Register tree views
    vscode.window.registerTreeDataProvider('vibe.sessions', sessionsTreeProvider);
    vscode.window.registerTreeDataProvider('vibe.codeSlices', codeSlicesTreeProvider);
    vscode.window.registerTreeDataProvider('vibe.issues', issuesTreeProvider);

    // Register commands
    registerCommands(context);

    // Start indexing in background
    startIndexing();

    // Show welcome message
    showWelcome();
  } catch (error) {
    console.error('Radium activation failed:', error);
    vscode.window.showErrorMessage(`Radium failed to activate: ${error}`);
    // Still register basic commands
    registerCommands(context);
  }
}

function registerCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe.openMap', () => {
      MapPanel.createOrShow(context.extensionUri, store, configLoader, gitDiffTracker);
    }),

    vscode.commands.registerCommand('vibe.showChanges', async () => {
      if (!store || !gitDiffTracker) {
        vscode.window.showWarningMessage('Store not initialized');
        return;
      }

      // Build options: git diff + recent sessions
      const quickPickItems: any[] = [];

      // Add git diff option
      quickPickItems.push({
        label: '$(git-branch) Current Git Changes',
        description: 'Show uncommitted changes in working directory',
        kind: 'git'
      });

      quickPickItems.push({
        label: '',
        kind: vscode.QuickPickItemKind.Separator
      });

      // Add recent sessions
      const sessions = store.getRecentSessions(10);
      sessions.forEach(s => {
        quickPickItems.push({
          label: `$(${s.actor === 'LLM' ? 'robot' : 'person'}) ${s.actor} - ${new Date(s.started_at).toLocaleString()}`,
          description: s.origin,
          session: s,
          kind: 'session'
        });
      });

      const selected = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: 'Select changes to visualize in the map'
      });

      if (!selected) return;

      if (selected.kind === 'git') {
        // Show git changes
        const sessionId = await gitDiffTracker.createSessionFromGitChanges();
        
        if (!sessionId) {
          vscode.window.showInformationMessage('No uncommitted changes found');
          return;
        }

        const changes = store.getChangesBySession(sessionId);
        
        // Open map
        MapPanel.createOrShow(context.extensionUri, store, configLoader, gitDiffTracker);
        
        // Update overlay after a short delay
        setTimeout(() => {
          if (MapPanel.currentPanel) {
            MapPanel.currentPanel.updateOverlay(sessionId);
          }
        }, 500);
        
        vscode.window.showInformationMessage(
          `Highlighting ${changes.length} uncommitted file(s)`
        );
      } else if (selected.session) {
        // Show session changes
        const changes = store.getChangesBySession(selected.session.id!);
        
        // Open map
        MapPanel.createOrShow(context.extensionUri, store, configLoader, gitDiffTracker);
        
        // Update overlay after a short delay
        setTimeout(() => {
          if (MapPanel.currentPanel) {
            MapPanel.currentPanel.updateOverlay(selected.session.id!);
          }
        }, 500);
        
        vscode.window.showInformationMessage(
          `Highlighting ${changes.length} changed file(s) in session`
        );
      }
    }),

    vscode.commands.registerCommand('vibe.previewLLMPlan', async () => {
      try {
        const clipboardText = await vscode.env.clipboard.readText();
        const plan: LLMPlan = JSON.parse(clipboardText);

        const preview = await orchestrator.previewPlan(plan);

        if (preview.issues.length > 0) {
          const proceed = await vscode.window.showWarningMessage(
            `Preview has ${preview.issues.length} issue(s). Continue?`,
            'Yes', 'No'
          );
          if (proceed !== 'Yes') {
            return;
          }
        }

        // Show preview
        const message = `Preview ready with ${preview.changes.size} file(s) changed. Apply?`;
        const action = await vscode.window.showInformationMessage(
          message,
          'Apply', 'Cancel'
        );

        if (action === 'Apply') {
          await orchestrator.applyPlan(preview, plan);
          vscode.window.showInformationMessage('LLM plan applied successfully');
          
          // Refresh views
          sessionsTreeProvider.refresh();
          codeSlicesTreeProvider.refresh();
          
          // Update map if open
          if (MapPanel.currentPanel) {
            MapPanel.currentPanel.updateGraph();
            MapPanel.currentPanel.updateOverlay(preview.sessionId);
          }
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to preview plan: ${error}`);
      }
    }),

    vscode.commands.registerCommand('vibe.applyLLMPlan', async () => {
      // Same as preview but auto-apply
      await vscode.commands.executeCommand('vibe.previewLLMPlan');
    }),

    vscode.commands.registerCommand('vibe.undoSession', async () => {
      const sessions = store.getRecentSessions(10);
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('No sessions to undo');
        return;
      }

      const items = sessions.map(s => ({
        label: `${s.actor} - ${new Date(s.started_at).toLocaleString()}`,
        session: s
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a session to undo'
      });

      if (selected) {
        try {
          await orchestrator.undoSession(selected.session.id!);
          vscode.window.showInformationMessage('Session undone successfully');
          sessionsTreeProvider.refresh();
          codeSlicesTreeProvider.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to undo session: ${error}`);
        }
      }
    }),

    vscode.commands.registerCommand('vibe.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }

      const selection = editor.selection;
      const text = editor.document.getText(selection);
      
      // This would integrate with an LLM API
      vscode.window.showInformationMessage(
        `Selected ${text.length} characters. LLM integration needed for explanation.`
      );
    }),

    vscode.commands.registerCommand('vibe.findImpact', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !store) {
        vscode.window.showWarningMessage('No active editor or store not initialized');
        return;
      }

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage('No workspace folder open');
        return;
      }

      const position = editor.selection.active;
      const offset = editor.document.offsetAt(position);
      const filePath = path.relative(workspaceFolders[0].uri.fsPath, editor.document.uri.fsPath);

      // Find node at this position
      const nodes = store.getNodesByPath(filePath);
      const node = nodes.find(n => 
        n.range_start <= offset && n.range_end >= offset
      );

      if (!node) {
        vscode.window.showInformationMessage('No symbol found at cursor');
        return;
      }

      // Get edges
      const edges = store.getEdgesByNode(node.id!);
      const impactedCount = edges.incoming.length + edges.outgoing.length;

      vscode.window.showInformationMessage(
        `Symbol "${node.name}" has ${impactedCount} connection(s): ${edges.incoming.length} incoming, ${edges.outgoing.length} outgoing`
      );

      // Show in map
      MapPanel.createOrShow(context.extensionUri, store, configLoader, gitDiffTracker);
    }),

    vscode.commands.registerCommand('vibe.exportSessionPatch', async () => {
      const sessions = store.getRecentSessions(10);
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('No sessions to export');
        return;
      }

      const items = sessions.map(s => ({
        label: `${s.actor} - ${new Date(s.started_at).toLocaleString()}`,
        session: s
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a session to export'
      });

      if (selected) {
        const changes = store.getChangesBySession(selected.session.id!);
        const patch = JSON.stringify({
          session: selected.session,
          changes: changes.map(c => ({
            file_id: c.file_id,
            hunks: JSON.parse(c.hunks_json),
            summary: c.summary
          }))
        }, null, 2);

        await vscode.env.clipboard.writeText(patch);
        vscode.window.showInformationMessage('Session patch copied to clipboard');
      }
    }),

    vscode.commands.registerCommand('vibe.refreshSessions', () => {
      sessionsTreeProvider.refresh();
      codeSlicesTreeProvider.refresh();
      issuesTreeProvider.refresh();
    }),

    vscode.commands.registerCommand('vibe.createTestSession', async () => {
      if (!store) {
        vscode.window.showWarningMessage('Store not initialized');
        return;
      }

      // Create a test session
      const sessionId = store.createSession({
        actor: 'LLM',
        actor_version: 'Test Session',
        origin: 'test',
        started_at: Date.now()
      });

      // Get some indexed files
      const files = store.getAllFiles();
      if (files.length === 0) {
        vscode.window.showWarningMessage('No files indexed yet. Wait for indexing to complete.');
        return;
      }

      // Mark first few files as "changed" for testing
      const filesToMark = files.slice(0, Math.min(3, files.length));
      
      for (const file of filesToMark) {
        store.insertChange({
          session_id: sessionId,
          file_id: file.id!,
          hunks_json: JSON.stringify({
            filePath: file.path,
            beforeHash: file.hash,
            afterHash: file.hash,
            hunks: [{
              start: 0,
              end: 10,
              type: 'modify',
              text: 'Sample change'
            }]
          }),
          summary: `Test change to ${file.path}`,
          ts: Date.now()
        });
      }

      store.endSession(sessionId, Date.now());

      vscode.window.showInformationMessage(
        `Test session created with ${filesToMark.length} changed file(s)`,
        'Show Changes'
      ).then(action => {
        if (action === 'Show Changes') {
          vscode.commands.executeCommand('vibe.showChanges');
        }
      });

      sessionsTreeProvider.refresh();
    }),

    vscode.commands.registerCommand('vibe.showChange', async (change: any) => {
      // Show change details
      const hunks = JSON.parse(change.hunks_json);
      vscode.window.showInformationMessage(
        `Change to ${hunks.filePath}: ${change.summary || 'No summary'}`
      );
    })
  );
}

function startIndexing() {
  if (!indexer) return;
  
  vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Radium: Indexing workspace',
    cancellable: false
  }, async (progress) => {
    try {
      await indexer.start();
      progress.report({ increment: 100 });
    } catch (error) {
      console.error('Indexing failed:', error);
      vscode.window.showErrorMessage(`Radium indexing failed: ${error}`);
    }
  });
}

function showWelcome() {
  vscode.window.showInformationMessage(
    'Radium is active! Open the map with "Vibe: Open Map"',
    'Open Map'
  ).then(action => {
    if (action === 'Open Map') {
      vscode.commands.executeCommand('vibe.openMap');
    }
  });
}

export function deactivate() {
  if (indexer) {
    indexer.stop();
  }
  if (store) {
    store.close();
  }
}

