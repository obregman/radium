import * as vscode from 'vscode';
import * as path from 'path';
import { GraphStore } from './store/schema';
import { Indexer } from './indexer/indexer';
import { LLMOrchestrator, LLMPlan } from './orchestrator/llm-orchestrator';
import { SessionsTreeProvider, CodeSlicesTreeProvider, IssuesTreeProvider } from './views/sessions-tree';
import { MapPanel } from './views/map-panel';
import { FeaturesMapPanel } from './views/features-map-panel';
import { DevModePanel } from './views/dev-mode-panel';
import { GitDiffTracker } from './git/git-diff-tracker';
import { RadiumConfigLoader } from './config/radium-config';
import { FeaturesConfigLoader } from './config/features-config';
import { RequirementsConfigLoader } from './config/requirements-config';
import { AIValidator } from './validation/ai-validator';

let store: GraphStore;
let indexer: Indexer;
let orchestrator: LLMOrchestrator;
let gitDiffTracker: GitDiffTracker;
let sessionsTreeProvider: SessionsTreeProvider;
let codeSlicesTreeProvider: CodeSlicesTreeProvider;
let issuesTreeProvider: IssuesTreeProvider;
let configLoader: RadiumConfigLoader;
let featuresLoader: FeaturesConfigLoader;
let requirementsLoader: RequirementsConfigLoader;
let aiValidator: AIValidator;
let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  // Create output channel for reliable logging
  outputChannel = vscode.window.createOutputChannel('Radium');
  outputChannel.show();
  
  outputChannel.appendLine('============================================');
  outputChannel.appendLine('RADIUM: Extension activation starting...');
  outputChannel.appendLine(`RADIUM: Extension path: ${context.extensionPath}`);
  outputChannel.appendLine(`RADIUM: Storage path: ${context.globalStorageUri.fsPath}`);
  outputChannel.appendLine('============================================');
  
  console.log('============================================');
  console.log('RADIUM: Extension activation starting...');
  console.log('RADIUM: Extension path:', context.extensionPath);
  console.log('RADIUM: Storage path:', context.globalStorageUri.fsPath);
  console.log('============================================');
  
  // Register webview serializer FIRST, before any initialization
  // This needs to be registered synchronously during activation
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('radiumDevMode', {
      async deserializeWebviewPanel(oldPanel: vscode.WebviewPanel, state: any) {
        console.log('[Extension] Deserializing Dev Mode panel');
        outputChannel.appendLine('[Extension] Deserializing Dev Mode panel');
        
        // Close the old panel to avoid stale content and handlers
        try { oldPanel.dispose(); } catch {}
        
        // Wait for initialization if needed
        let retries = 0;
        while ((!requirementsLoader || !aiValidator) && retries < 50) {
          await new Promise(resolve => setTimeout(resolve, 100));
          retries++;
        }
        
        if (!requirementsLoader || !aiValidator) {
          console.error('[Extension] Cannot deserialize panel: requirementsLoader or aiValidator not initialized after waiting');
          vscode.window.showErrorMessage('Dev Mode panel could not be restored. Please reopen it.');
          return;
        }
        
        // Reload requirements config
        requirementsLoader.load();
        
        // Create a new panel fresh to ensure working message plumbing
        DevModePanel.createOrShow(context.extensionUri, requirementsLoader, aiValidator);
      }
    })
  );
  
  // ALWAYS register commands first, even if initialization fails
  try {
    registerCommands(context);
    console.log('RADIUM: Commands registered successfully');
  } catch (cmdError) {
    console.error('RADIUM: FAILED to register commands:', cmdError);
    vscode.window.showErrorMessage(`Radium command registration failed: ${cmdError}`);
    throw cmdError;
  }

  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showWarningMessage('No workspace folder open. Radium requires a workspace.');
      return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const dbPath = path.join(context.globalStorageUri.fsPath, 'radium.db');

    // Ensure storage directory exists
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);

    // Initialize store
    console.log('Radium: Initializing store at:', dbPath);
    try {
      store = new GraphStore(dbPath);
      await store.init();
      console.log('Radium: Store initialized successfully');
    } catch (storeError) {
      console.error('Radium: Failed to initialize store:', storeError);
      throw new Error(`Store initialization failed: ${storeError}`);
    }

    // Initialize config loaders
    configLoader = new RadiumConfigLoader(workspaceRoot);
    configLoader.load();
    
    featuresLoader = new FeaturesConfigLoader(workspaceRoot);
    featuresLoader.load();

    requirementsLoader = new RequirementsConfigLoader(workspaceRoot);
    requirementsLoader.load();

    // Initialize AI validator
    aiValidator = new AIValidator(workspaceRoot);

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
    vscode.window.registerTreeDataProvider('radium.sessions', sessionsTreeProvider);
    vscode.window.registerTreeDataProvider('radium.codeSlices', codeSlicesTreeProvider);
    vscode.window.registerTreeDataProvider('radium.issues', issuesTreeProvider);

    // Start indexing in background
    startIndexing();

    // Show welcome message
    showWelcome();
    
    console.log('Radium activation complete');
  } catch (error) {
    console.error('============================================');
    console.error('RADIUM: ACTIVATION FAILED!');
    console.error('RADIUM: Error:', error);
    console.error('RADIUM: Stack:', (error as Error).stack);
    console.error('============================================');
    vscode.window.showErrorMessage(`Radium failed to activate: ${error}`, 'Show Logs').then(action => {
      if (action === 'Show Logs') {
        vscode.commands.executeCommand('workbench.action.toggleDevTools');
      }
    });
    throw error; // Re-throw to ensure VS Code knows activation failed
  }
}

function registerCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('radium.openMap', () => {
      if (!store) {
        vscode.window.showWarningMessage('Radium is still initializing. Please wait...');
        return;
      }
      MapPanel.createOrShow(context.extensionUri, store, configLoader, gitDiffTracker);
    }),

    vscode.commands.registerCommand('radium.openFeaturesMap', () => {
      if (!featuresLoader || !configLoader) {
        vscode.window.showWarningMessage('Radium is still initializing. Please wait...');
        return;
      }
      // Reload configs in case files were created/modified since activation
      configLoader.load();
      featuresLoader.load();
      FeaturesMapPanel.createOrShow(context.extensionUri, featuresLoader, configLoader);
    }),

    vscode.commands.registerCommand('radium.openDevMode', async () => {
      if (!requirementsLoader || !aiValidator) {
        vscode.window.showWarningMessage('Radium is still initializing. Please wait...');
        return;
      }
      
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage('No workspace folder open');
        return;
      }
      
      const fs = require('fs');
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      const reqPath = path.join(workspaceRoot, 'radium-req.yaml');
      const examplePath = path.join(workspaceRoot, 'radium-req.yaml.example');
      
      // Check if radium-req.yaml exists
      if (!fs.existsSync(reqPath) && fs.existsSync(examplePath)) {
        const action = await vscode.window.showInformationMessage(
          'No radium-req.yaml found. Would you like to create one from the example?',
          'Create from Example',
          'Create Empty',
          'Cancel'
        );
        
        if (action === 'Create from Example') {
          fs.copyFileSync(examplePath, reqPath);
          vscode.window.showInformationMessage('Created radium-req.yaml from example');
        } else if (action === 'Create Empty') {
          const emptyContent = `# Radium Requirements Configuration
spec:
  requirements: []
`;
          fs.writeFileSync(reqPath, emptyContent, 'utf8');
          vscode.window.showInformationMessage('Created empty radium-req.yaml');
        } else {
          return;
        }
      }
      
      // Reload requirements config in case file was created/modified since activation
      requirementsLoader.load();
      
      // Show info message about dev mode
      vscode.window.showInformationMessage(
        'Dev Mode: Manage feature requirements and validate implementation status',
        'Got it'
      );
      
      DevModePanel.createOrShow(context.extensionUri, requirementsLoader, aiValidator);
    }),

    vscode.commands.registerCommand('radium.showChanges', async () => {
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

    vscode.commands.registerCommand('radium.previewLLMPlan', async () => {
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

    vscode.commands.registerCommand('radium.applyLLMPlan', async () => {
      // Same as preview but auto-apply
      await vscode.commands.executeCommand('radium.previewLLMPlan');
    }),

    vscode.commands.registerCommand('radium.undoSession', async () => {
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

    vscode.commands.registerCommand('radium.explainSelection', async () => {
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

    vscode.commands.registerCommand('radium.findImpact', async () => {
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
      const filePath = path.relative(workspaceFolders[0].uri.fsPath, editor.document.uri.fsPath).replace(/\\/g, '/');

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

    vscode.commands.registerCommand('radium.exportSessionPatch', async () => {
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

    vscode.commands.registerCommand('radium.refreshSessions', () => {
      sessionsTreeProvider.refresh();
      codeSlicesTreeProvider.refresh();
      issuesTreeProvider.refresh();
    }),

    vscode.commands.registerCommand('radium.createTestSession', async () => {
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
          vscode.commands.executeCommand('radium.showChanges');
        }
      });

      sessionsTreeProvider.refresh();
    }),

    vscode.commands.registerCommand('radium.showChange', async (change: any) => {
      // Show change details
      const hunks = JSON.parse(change.hunks_json);
      vscode.window.showInformationMessage(
        `Change to ${hunks.filePath}: ${change.summary || 'No summary'}`
      );
    }),

    vscode.commands.registerCommand('radium.reindex', async () => {
      outputChannel.appendLine('============================================');
      outputChannel.appendLine('RADIUM: RE-INDEX COMMAND CALLED');
      outputChannel.appendLine(`RADIUM: indexer exists: ${!!indexer}`);
      outputChannel.appendLine(`RADIUM: store exists: ${!!store}`);
      outputChannel.appendLine('============================================');
      
      console.log('============================================');
      console.log('RADIUM: RE-INDEX COMMAND CALLED');
      console.log('RADIUM: indexer exists:', !!indexer);
      console.log('RADIUM: store exists:', !!store);
      console.log('============================================');
      
      if (!indexer || !store) {
        outputChannel.appendLine('RADIUM: Cannot re-index - indexer or store not initialized');
        console.error('RADIUM: Cannot re-index - indexer or store not initialized');
        vscode.window.showWarningMessage('Radium not initialized');
        return;
      }

      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Radium: Re-indexing workspace',
        cancellable: false
      }, async (progress) => {
        try {
          outputChannel.appendLine('RADIUM: Starting manual re-index...');
          console.log('RADIUM: Starting manual re-index...');
          await indexer.start();
          progress.report({ increment: 100 });
          
          const fileCount = store.getAllFiles().length;
          outputChannel.appendLine(`RADIUM: Re-index complete - ${fileCount} files in store`);
          console.log(`RADIUM: Re-index complete - ${fileCount} files in store`);
          
          vscode.window.showInformationMessage(
            `Radium: Indexed ${fileCount} file(s) successfully`
          );
          
          // Refresh views
          if (sessionsTreeProvider) sessionsTreeProvider.refresh();
          if (codeSlicesTreeProvider) codeSlicesTreeProvider.refresh();
          if (MapPanel.currentPanel) MapPanel.currentPanel.updateGraph();
        } catch (error) {
          outputChannel.appendLine(`RADIUM: Re-indexing failed: ${error}`);
          outputChannel.appendLine(`RADIUM: Error stack: ${(error as Error).stack}`);
          console.error('RADIUM: Re-indexing failed:', error);
          console.error('RADIUM: Error stack:', (error as Error).stack);
          vscode.window.showErrorMessage(`Radium re-indexing failed: ${error}`);
        }
      });
    }),

    vscode.commands.registerCommand('radium.selectAIProvider', async () => {
      const config = vscode.workspace.getConfiguration('radium.devMode');
      const currentProvider = config.get<string>('aiProvider', 'copilot');
      
      const providers = [
        {
          label: '$(cursor) Cursor AI',
          description: currentProvider === 'cursor' ? '(Current)' : 'Recommended for Cursor users',
          value: 'cursor'
        },
        {
          label: '$(github) GitHub Copilot',
          description: currentProvider === 'copilot' ? '(Current)' : 'Requires Copilot subscription',
          value: 'copilot'
        },
        {
          label: '$(cloud) Claude API',
          description: currentProvider === 'claude' ? '(Current)' : 'Coming soon',
          value: 'claude'
        }
      ];

      const selected = await vscode.window.showQuickPick(providers, {
        placeHolder: 'Select AI provider for requirement validation',
        title: 'AI Provider Selection'
      });

      if (selected) {
        await config.update('aiProvider', selected.value, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`AI provider set to: ${selected.label}`);
        
        // Reinitialize AI validator with new provider
        if (aiValidator) {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders) {
            aiValidator = new AIValidator(workspaceFolders[0].uri.fsPath);
          }
        }
      }
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
      vscode.commands.executeCommand('radium.openMap');
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

