import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GraphStore } from './store/schema';
import { Indexer } from './indexer/indexer';
import { LLMOrchestrator, LLMPlan } from './orchestrator/llm-orchestrator';
import { MapPanel } from './views/codebase-map-panel';
import { FeaturesMapPanel } from './views/features-map-panel';
import { RealtimeChangesPanel } from './views/realtime-changes-panel';
import { SymbolChangesPanel } from './views/symbol-changes-panel';
import { SemanticChangesPanel } from './views/semantic-changes-panel';
import { GitDiffTracker } from './git/git-diff-tracker';
import { RadiumConfigLoader } from './config/radium-config';
import { FeaturesConfigLoader } from './config/features-config';

let store: GraphStore;
let indexer: Indexer;
let orchestrator: LLMOrchestrator;
let gitDiffTracker: GitDiffTracker;
let configLoader: RadiumConfigLoader;
let featuresLoader: FeaturesConfigLoader;
let outputChannel: vscode.OutputChannel;

/**
 * Find the workspace folder that contains a .radium directory
 * If multiple folders have .radium, prompt user to select
 * If none have .radium, return the first folder
 */
async function findRadiumWorkspaceRoot(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<string> {
  outputChannel.appendLine('=== Searching for .radium directory ===');
  outputChannel.appendLine(`Total workspace folders: ${workspaceFolders.length}`);
  
  const foldersWithRadium: vscode.WorkspaceFolder[] = [];
  
  // Check each workspace folder for .radium directory
  for (const folder of workspaceFolders) {
    const radiumPath = path.join(folder.uri.fsPath, '.radium');
    outputChannel.appendLine(`Checking: ${folder.name} (${folder.uri.fsPath})`);
    outputChannel.appendLine(`  Looking for: ${radiumPath}`);
    
    if (fs.existsSync(radiumPath)) {
      const stats = fs.statSync(radiumPath);
      if (stats.isDirectory()) {
        outputChannel.appendLine(`  ✓ Found .radium directory!`);
        foldersWithRadium.push(folder);
        
        // List files in .radium directory
        try {
          const files = fs.readdirSync(radiumPath);
          outputChannel.appendLine(`  Files in .radium: ${files.join(', ')}`);
        } catch (err) {
          outputChannel.appendLine(`  Could not read .radium directory: ${err}`);
        }
      } else {
        outputChannel.appendLine(`  ✗ .radium exists but is not a directory`);
      }
    } else {
      outputChannel.appendLine(`  ✗ No .radium directory found`);
    }
  }
  
  outputChannel.appendLine(`Found ${foldersWithRadium.length} workspace folder(s) with .radium directory`);
  
  // If no folders have .radium, use the first folder
  if (foldersWithRadium.length === 0) {
    outputChannel.appendLine(`⚠ No .radium directory found in any workspace folder, using first folder: ${workspaceFolders[0].name}`);
    return workspaceFolders[0].uri.fsPath;
  }
  
  // If only one folder has .radium, use it
  if (foldersWithRadium.length === 1) {
    outputChannel.appendLine(`✓ Using workspace folder: ${foldersWithRadium[0].name} (${foldersWithRadium[0].uri.fsPath})`);
    return foldersWithRadium[0].uri.fsPath;
  }
  
  // Multiple folders have .radium - ask user to select
  outputChannel.appendLine(`Multiple folders have .radium, prompting user to select...`);
  const items = foldersWithRadium.map(folder => ({
    label: folder.name,
    description: folder.uri.fsPath,
    folder: folder
  }));
  
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Multiple workspace folders contain .radium directory. Select one:',
    ignoreFocusOut: true
  });
  
  if (selected) {
    outputChannel.appendLine(`✓ User selected workspace: ${selected.folder.name} (${selected.folder.uri.fsPath})`);
    return selected.folder.uri.fsPath;
  }
  
  // User cancelled - use the first one with .radium
  outputChannel.appendLine(`⚠ User cancelled selection, using first folder with .radium: ${foldersWithRadium[0].name}`);
  return foldersWithRadium[0].uri.fsPath;
}

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

    // Find workspace folder(s) with .radium directory
    const workspaceRoot = await findRadiumWorkspaceRoot(workspaceFolders);
    outputChannel.appendLine(`=== Using workspace root: ${workspaceRoot} ===`);
    
    const dbPath = path.join(context.globalStorageUri.fsPath, 'radium.db');

    // Ensure storage directory exists
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);

    // Initialize store
    outputChannel.appendLine(`Initializing store at: ${dbPath}`);
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

    // Initialize indexer
    indexer = new Indexer(store, workspaceRoot);
    
    // Initialize orchestrator
    orchestrator = new LLMOrchestrator(store, workspaceRoot);

    // Initialize git diff tracker with indexer reference
    gitDiffTracker = new GitDiffTracker(store, workspaceRoot, indexer);

    // Start indexing in background
    startIndexing();

    // Show welcome message
    // showWelcome();
    
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

    vscode.commands.registerCommand('radium.realtimeChanges', () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage('No workspace folder open. Radium requires a workspace.');
        return;
      }
      RealtimeChangesPanel.createOrShow(context.extensionUri, workspaceFolders[0].uri.fsPath);
    }),

    vscode.commands.registerCommand('radium.symbolChanges', () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage('No workspace folder open. Radium requires a workspace.');
        return;
      }
      SymbolChangesPanel.createOrShow(context.extensionUri, workspaceFolders[0].uri.fsPath);
    }),

    vscode.commands.registerCommand('radium.detailedCodeChanges', () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage('No workspace folder open. Radium requires a workspace.');
        return;
      }
      SymbolChangesPanel.createOrShow(context.extensionUri, workspaceFolders[0].uri.fsPath);
    }),

    vscode.commands.registerCommand('radium.gitChanges', () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage('No workspace folder open. Radium requires a workspace.');
        return;
      }
      SymbolChangesPanel.createOrShowGitChanges(context.extensionUri, workspaceFolders[0].uri.fsPath);
    }),

    vscode.commands.registerCommand('radium.semanticChanges', () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage('No workspace folder open. Radium requires a workspace.');
        return;
      }
      SemanticChangesPanel.createOrShow(context.extensionUri, workspaceFolders[0].uri.fsPath);
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

