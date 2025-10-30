import * as vscode from 'vscode';
import * as path from 'path';
import { GraphStore } from './store/schema';
import { Indexer } from './indexer/indexer';
import { LLMOrchestrator, LLMPlan } from './orchestrator/llm-orchestrator';
import { MapPanel } from './views/map-panel';
import { FeaturesMapPanel } from './views/features-map-panel';
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

    // Initialize indexer
    indexer = new Indexer(store, workspaceRoot);
    
    // Initialize orchestrator
    orchestrator = new LLMOrchestrator(store, workspaceRoot);

    // Initialize git diff tracker with indexer reference
    gitDiffTracker = new GitDiffTracker(store, workspaceRoot, indexer);

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

