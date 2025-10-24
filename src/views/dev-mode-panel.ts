import * as vscode from 'vscode';
import { RequirementsConfigLoader, Requirement } from '../config/requirements-config';
import { AIValidator } from '../validation/ai-validator';

export class DevModePanel {
  public static currentPanel: DevModePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private static extensionUri: vscode.Uri;
  private static requirementsLoader: RequirementsConfigLoader;
  private static aiValidator: AIValidator;
  private static logChannel: vscode.OutputChannel | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private requirementsLoader: RequirementsConfigLoader,
    private aiValidator: AIValidator
  ) {
    this.panel = panel;
    if (!DevModePanel.logChannel) {
      DevModePanel.logChannel = vscode.window.createOutputChannel('Radium DevMode');
    }
    
    // Set up message handler BEFORE setting HTML to avoid missing early messages
    this.panel.webview.onDidReceiveMessage(
      message => {
        console.log('[Dev Mode] onDidReceiveMessage triggered with:', message);
        DevModePanel.logChannel?.appendLine(`[Dev Mode] Message received: ${message?.type}`);
        this.handleMessage(message);
      },
      null,
      this.disposables
    );

    // Now assign HTML content
    this.panel.webview.html = this.getHtmlContent(extensionUri);
    DevModePanel.logChannel?.appendLine('[Dev Mode] Webview HTML set');

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Send initial data
    this.updateView();
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    requirementsLoader: RequirementsConfigLoader,
    aiValidator: AIValidator
  ) {
    // Store references for potential restoration
    DevModePanel.extensionUri = extensionUri;
    DevModePanel.requirementsLoader = requirementsLoader;
    DevModePanel.aiValidator = aiValidator;

    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DevModePanel.currentPanel) {
      console.log('[Dev Mode] Reusing existing panel');
      vscode.window.showInformationMessage('DEBUG: Reusing existing panel');
      DevModePanel.currentPanel.panel.reveal(column);
      DevModePanel.currentPanel.updateView();
      return;
    }

    console.log('[Dev Mode] Creating new panel');
    vscode.window.showInformationMessage('DEBUG: Creating new panel');
    
    const panel = vscode.window.createWebviewPanel(
      'radiumDevMode',
      'Radium Dev Mode',
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [extensionUri],
        enableFindWidget: true
      }
    );

    DevModePanel.currentPanel = new DevModePanel(
      panel,
      extensionUri,
      requirementsLoader,
      aiValidator
    );
  }

  public static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    requirementsLoader: RequirementsConfigLoader,
    aiValidator: AIValidator
  ) {
    console.log('[Dev Mode] Reviving panel');
    vscode.window.showInformationMessage('DEBUG: Reviving panel');
    DevModePanel.currentPanel = new DevModePanel(panel, extensionUri, requirementsLoader, aiValidator);
  }

  private async handleMessage(message: any) {
    console.log('[Dev Mode] Received message:', message.type, message);
    console.log('[Dev Mode] Full message object:', JSON.stringify(message));
    
    try {
      console.log('[Dev Mode] About to enter switch statement');
      switch (message.type) {
        case 'ready':
          this.updateView();
          break;
        case 'feature:add':
          await this.handleAddFeature();
          break;
        case 'feature:edit':
          await this.handleEditFeature(message.featureKey);
          break;
        case 'feature:delete':
          await this.handleDeleteFeature(message.featureKey);
          break;
        case 'requirement:add':
          await this.handleAddRequirement(message.featureKey);
          break;
        case 'requirement:edit':
          await this.handleEditRequirement(message.featureKey, message.requirementId);
          break;
        case 'requirement:delete':
          console.log('[Dev Mode] Handling requirement:delete');
          vscode.window.showInformationMessage(`DEBUG: Delete request received for ${message.requirementId}`);
          await this.handleDeleteRequirement(message.featureKey, message.requirementId);
          break;
        case 'requirement:build':
          console.log('[Dev Mode] Handling requirement:build, featureKey:', message.featureKey, 'requirementId:', message.requirementId);
          await this.handleBuildRequirement(message.featureKey, message.requirementId);
          console.log('[Dev Mode] handleBuildRequirement completed');
          break;
        case 'requirement:remove':
          await this.handleRemoveRequirement(message.featureKey, message.requirementId);
          break;
        case 'requirement:validate':
          await this.handleValidateRequirement(message.featureKey, message.requirementId);
          break;
        case 'feature:validateAll':
          await this.handleValidateAllRequirements(message.featureKey);
          break;
        default:
          console.warn('[Dev Mode] Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('[Dev Mode] Error handling message:', error);
      vscode.window.showErrorMessage(`Error handling message: ${error}`);
    }
  }

  private async handleAddFeature() {
    const featureName = await vscode.window.showInputBox({
      prompt: 'Enter feature name',
      placeHolder: 'e.g., User Authentication'
    });

    if (!featureName) {
      return;
    }

    const description = await vscode.window.showInputBox({
      prompt: 'Enter feature description (optional)',
      placeHolder: 'e.g., Handles user login and registration'
    });

    // Create feature key from name
    const featureKey = featureName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    
    // Initialize empty requirements array for this feature
    const config = this.requirementsLoader.getConfig();
    if (config && !config.requirements[featureKey]) {
      config.requirements[featureKey] = {
        name: featureName,
        description: description || '',
        requirements: []
      };
      this.requirementsLoader.save();
      vscode.window.showInformationMessage(`Feature "${featureName}" added`);
      this.updateView();
    } else {
      vscode.window.showWarningMessage('Feature already exists');
    }
  }

  private async handleEditFeature(featureKey: string) {
    const featureBlock = this.requirementsLoader.getFeatureBlock(featureKey);
    if (!featureBlock) {
      vscode.window.showErrorMessage('Feature not found');
      return;
    }

    const newName = await vscode.window.showInputBox({
      prompt: 'Enter new feature name',
      value: featureBlock.name
    });

    if (!newName) {
      return;
    }

    const newDescription = await vscode.window.showInputBox({
      prompt: 'Enter new feature description (optional)',
      value: featureBlock.description || ''
    });

    this.requirementsLoader.updateFeatureBlock(featureKey, {
      name: newName,
      description: newDescription || ''
    });
    
    vscode.window.showInformationMessage('Feature updated');
    this.updateView();
  }

  private async handleDeleteFeature(featureKey: string) {
    const confirm = await vscode.window.showWarningMessage(
      'Delete this feature and all its requirements?',
      'Delete',
      'Cancel'
    );

    if (confirm !== 'Delete') {
      return;
    }

    const config = this.requirementsLoader.getConfig();
    if (config && config.requirements[featureKey]) {
      delete config.requirements[featureKey];
      this.requirementsLoader.save();
      vscode.window.showInformationMessage('Feature deleted');
      this.updateView();
    }
  }

  private async handleAddRequirement(featureKey: string) {
    const text = await vscode.window.showInputBox({
      prompt: 'Enter requirement text',
      placeHolder: 'e.g., User can click the submit button'
    });

    if (!text) {
      return;
    }

    this.requirementsLoader.addRequirement(featureKey, text);
    vscode.window.showInformationMessage(`Requirement added`);
    this.updateView();
  }

  private async handleEditRequirement(featureKey: string, requirementId: string) {
    const requirements = this.requirementsLoader.getRequirements(featureKey);
    const requirement = requirements.find(r => r.id === requirementId);

    if (!requirement) {
      vscode.window.showErrorMessage('Requirement not found');
      return;
    }

    const newText = await vscode.window.showInputBox({
      prompt: 'Edit requirement text',
      value: requirement.text
    });

    if (!newText) {
      return;
    }

    this.requirementsLoader.updateRequirement(featureKey, requirementId, { text: newText });
    vscode.window.showInformationMessage('Requirement updated');
    this.updateView();
  }

  private async handleDeleteRequirement(featureKey: string, requirementId: string) {
    console.log(`[Dev Mode] Delete requirement requested: feature='${featureKey}', requirement='${requirementId}'`);
    DevModePanel.logChannel?.appendLine(`[Dev Mode] Delete request received for feature='${featureKey}', req='${requirementId}'`);
    
    // Check if requirement is implemented
    const requirements = this.requirementsLoader.getRequirements(featureKey);
    const requirement = requirements.find(r => r.id === requirementId);
    
    if (!requirement) {
      vscode.window.showErrorMessage('Requirement not found');
      return;
    }
    
    // Prevent deletion if requirement is not "not-started"
    if (requirement.status !== 'not-started') {
      vscode.window.showWarningMessage(
        'This requirement appears to be implemented in code. Please use "Remove from code" first to have AI remove the implementation before deleting the requirement.',
        'OK'
      );
      return;
    }
    
    // Copy delete prompt to clipboard and show a brief status message
    const deletePrompt = `Delete the following requirement from the radium-req.yaml specification only (no code changes).\n\nFeature: ${featureKey}\nRequirement: ${requirement.text}`;
    await vscode.env.clipboard.writeText(deletePrompt);
    vscode.window.setStatusBarMessage('Delete prompt copied to clipboard', 4000);
    
    // Log current requirements before deletion
    const beforeReqs = this.requirementsLoader.getRequirements(featureKey);
    console.log(`[Dev Mode] Requirements before deletion:`, beforeReqs.map(r => r.id));
    DevModePanel.logChannel?.appendLine(`[Dev Mode] Before deletion, requirements: ${beforeReqs.map(r => r.id).join(', ')}`);
    
    const confirm = await vscode.window.showWarningMessage(
      'Delete this requirement?',
      { modal: true },
      'Delete',
      'Cancel'
    );

    if (confirm !== 'Delete') {
      console.log('[Dev Mode] Delete cancelled by user');
      DevModePanel.logChannel?.appendLine('[Dev Mode] Delete cancelled by user');
      return;
    }

    console.log('[Dev Mode] User confirmed deletion, calling deleteRequirement...');
    DevModePanel.logChannel?.appendLine('[Dev Mode] User confirmed deletion');
    const success = this.requirementsLoader.deleteRequirement(featureKey, requirementId);
    
    if (success) {
      console.log('[Dev Mode] Requirement deleted successfully');
      DevModePanel.logChannel?.appendLine('[Dev Mode] Requirement deleted successfully, reloading config');
      
      // Reload config to ensure we have the latest state
      this.requirementsLoader.load();
      
      // Log requirements after deletion
      const afterReqs = this.requirementsLoader.getRequirements(featureKey);
      console.log(`[Dev Mode] Requirements after deletion:`, afterReqs.map(r => r.id));
      DevModePanel.logChannel?.appendLine(`[Dev Mode] After deletion, requirements: ${afterReqs.map(r => r.id).join(', ')}`);
      
      vscode.window.showInformationMessage('Requirement deleted');
      this.updateView();
    } else {
      console.error('[Dev Mode] Failed to delete requirement');
      DevModePanel.logChannel?.appendLine('[Dev Mode] ERROR: Failed to delete requirement');
      vscode.window.showErrorMessage('Failed to delete requirement. Check Output panel for details.');
    }
  }

  private async handleBuildRequirement(featureKey: string, requirementId: string) {
    console.log('[Dev Mode] handleBuildRequirement called:', featureKey, requirementId);
    
    let requirements;
    let requirement;
    try {
      requirements = this.requirementsLoader.getRequirements(featureKey);
      requirement = requirements.find(r => r.id === requirementId);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to load requirements: ${error}`);
      return;
    }

    if (!requirement) {
      vscode.window.showErrorMessage('Requirement not found');
      return;
    }

    const prompt = `Build the following requirement and provide implementation steps and code edits as needed.\n\nFeature: ${featureKey}\nRequirement: ${requirement.text}`;

    await vscode.env.clipboard.writeText(prompt);
    vscode.window.setStatusBarMessage('Build prompt copied to clipboard', 4000);
  }

  private async handleRemoveRequirement(featureKey: string, requirementId: string) {
    const requirements = this.requirementsLoader.getRequirements(featureKey);
    const requirement = requirements.find(r => r.id === requirementId);

    if (!requirement) {
      vscode.window.showErrorMessage('Requirement not found');
      return;
    }

    const prompt = `Remove the following requirement from the code. Identify and revert all related changes (code, tests, docs) and ensure build/tests pass.\n\nFeature: ${featureKey}\nRequirement: ${requirement.text}`;

    await vscode.env.clipboard.writeText(prompt);
    vscode.window.setStatusBarMessage('Removal prompt copied to clipboard', 4000);

    const action = await vscode.window.showInformationMessage(
      'After removing the implementation, set status to not-started to allow deletion.',
      'Set to Not-Started Now',
      'OK'
    );

    if (action === 'Set to Not-Started Now') {
      this.requirementsLoader.updateRequirement(featureKey, requirementId, { status: 'not-started' });
      vscode.window.showInformationMessage('Requirement status set to "not-started". You can now delete it.');
      this.updateView();
    }
  }

  private async handleValidateRequirement(featureKey: string, requirementId: string) {
    const requirements = this.requirementsLoader.getRequirements(featureKey);
    const requirement = requirements.find(r => r.id === requirementId);

    if (!requirement) {
      vscode.window.showErrorMessage('Requirement not found');
      return;
    }
    
    // Copy validation prompt to clipboard and show a brief status message
    const validationPrompt = `Validate the implementation status of the following requirement in the current codebase. Respond ONLY with JSON: {\\n  \"status\": \"implemented\" | \"in-progress\" | \"not-started\",\\n  \"confidence\": <0-100>,\\n  \"reasoning\": \"<one sentence>\"\\n}\\n\\nFeature: ${featureKey}\\nRequirement: ${requirement.text}`;
    await vscode.env.clipboard.writeText(validationPrompt);
    vscode.window.setStatusBarMessage('Validation prompt copied to clipboard', 4000);
  }

  private async handleValidateAllRequirements(featureKey: string) {
    const requirements = this.requirementsLoader.getRequirements(featureKey);

    if (requirements.length === 0) {
      vscode.window.showErrorMessage('No requirements to validate');
      return;
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Validating ${requirements.length} requirements...`,
      cancellable: false
    }, async () => {
      const featureConfig = {
        name: featureKey.replace(/-/g, ' '),
        components: []
      };

      const results = await this.aiValidator.validateFeatureRequirements(requirements, featureConfig as any, featureKey);
      
      let successCount = 0;
      let failedCount = 0;
      
      for (const result of results) {
        // Only update status if validation was successful (confidence > 0)
        if (result.confidence > 0) {
          this.requirementsLoader.updateRequirement(featureKey, result.requirementId, {
            status: result.status
          });
          successCount++;
        } else {
          failedCount++;
        }
      }

      const implementedCount = results.filter(r => r.status === 'implemented' || r.status === 'verified').length;
      
      if (failedCount > 0) {
        vscode.window.showWarningMessage(
          `Validation complete: ${implementedCount}/${requirements.length} requirements implemented\n${failedCount} validation(s) failed and status unchanged.`
        );
      } else {
        vscode.window.showInformationMessage(
          `Validation complete: ${implementedCount}/${requirements.length} requirements implemented`
        );
      }

      this.updateView();
    });
  }

  public updateView() {
    console.log('[Dev Mode] updateView called');
    DevModePanel.logChannel?.appendLine('[Dev Mode] updateView called');
    const requirementsConfig = this.requirementsLoader.getConfig();
    console.log('[Dev Mode] Requirements config:', requirementsConfig);
    DevModePanel.logChannel?.appendLine('[Dev Mode] Requirements config loaded');

    if (!requirementsConfig || Object.keys(requirementsConfig.requirements).length === 0) {
      // Check if radium-req.yaml exists
      const fs = require('fs');
      const path = require('path');
      const workspaceFolders = require('vscode').workspace.workspaceFolders;
      
      if (workspaceFolders) {
        const reqPath = path.join(workspaceFolders[0].uri.fsPath, 'radium-req.yaml');
        const examplePath = path.join(workspaceFolders[0].uri.fsPath, 'radium-req.yaml.example');
        
        if (!fs.existsSync(reqPath) && fs.existsSync(examplePath)) {
          this.panel.webview.postMessage({
            type: 'empty',
            message: 'No radium-req.yaml found. Copy radium-req.yaml.example to radium-req.yaml to get started, or click "+ Add Feature" to create a new file.'
          });
          return;
        }
      }
      
      const payload = {
        type: 'empty',
        message: 'No features found. Click "+ Add Feature" to get started.'
      };
      DevModePanel.logChannel?.appendLine('[Dev Mode] Posting message to webview: empty');
      this.panel.webview.postMessage(payload);
      return;
    }

    // Transform data for the view
    const features = Object.entries(requirementsConfig.requirements).map(([key, featureBlock]) => ({
      key,
      name: featureBlock.name,
      description: featureBlock.description,
      requirements: featureBlock.requirements
    }));

    console.log('[Dev Mode] Sending update message to webview with', features.length, 'features');
    const updateMsg = {
      type: 'update',
      data: { features }
    };
    DevModePanel.logChannel?.appendLine(`[Dev Mode] Posting message to webview: update with ${features.length} features`);
    this.panel.webview.postMessage(updateMsg);
    console.log('[Dev Mode] Update message sent');
  }

  private getHtmlContent(extensionUri: vscode.Uri): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Radium Dev Mode</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    
    #container {
      max-width: 1400px;
      margin: 0 auto;
    }
    
    .search-container {
      position: sticky;
      top: 0;
      background: #1e1e1e;
      padding: 16px 20px;
      border-bottom: 1px solid #333;
      z-index: 100;
      max-width: 1400px;
      margin: 0 auto;
    }
    
    .search-input {
      width: 100%;
      padding: 10px 16px;
      background: #2d2d2d;
      border: 1px solid #444;
      border-radius: 6px;
      color: #d4d4d4;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
      box-sizing: border-box;
    }
    
    .search-input:focus {
      border-color: #007acc;
    }
    
    .search-input::placeholder {
      color: #888;
    }
    
    .content-wrapper {
      padding: 20px;
    }
    
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 1px solid #444;
    }
    
    .header h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
    }
    
    .add-feature-btn {
      background: #0e639c;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.2s;
    }
    
    .add-feature-btn:hover {
      background: #1177bb;
    }
    
    .features-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
      gap: 20px;
    }
    
    .feature-block {
      background: #2d2d2d;
      border: 2px solid #4a9eff;
      border-radius: 8px;
      padding: 20px;
      transition: transform 0.2s, box-shadow 0.2s, opacity 0.2s;
    }
    
    .feature-block.hidden {
      display: none;
    }
    
    .feature-block:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(74, 158, 255, 0.3);
    }
    
    .feature-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 1px solid #444;
    }
    
    .feature-title {
      font-size: 18px;
      font-weight: 600;
      color: #4a9eff;
      margin: 0 0 5px 0;
    }
    
    .feature-description {
      font-size: 13px;
      color: #888;
      margin: 0;
      line-height: 1.4;
    }
    
    .feature-menu {
      position: relative;
    }
    
    .menu-button {
      background: transparent;
      border: none;
      color: #d4d4d4;
      cursor: pointer;
      padding: 5px 10px;
      font-size: 20px;
      opacity: 0.6;
      transition: opacity 0.2s;
    }
    
    .menu-button:hover {
      opacity: 1;
    }
    
    .context-menu {
      position: absolute;
      right: 0;
      top: 100%;
      background: #2d2d2d;
      border: 1px solid #444;
      border-radius: 3px;
      padding: 2px 0;
      min-width: 100px;
      max-width: 120px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
      z-index: 10000;
      display: none;
    }
    
    .context-menu.show {
      display: block;
    }
    
    .context-menu-item {
      padding: 5px 10px;
      cursor: pointer;
      color: #d4d4d4;
      font-size: 11px;
      transition: background 0.1s;
      white-space: nowrap;
    }
    
    .context-menu-item:hover {
      background: #3e3e3e;
    }
    
    .context-menu-separator {
      height: 1px;
      background: #444;
      margin: 2px 0;
    }
    
    .requirements-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .requirement-item {
      background: #252525;
      border-radius: 6px;
      padding: 12px;
      display: flex;
      align-items: center;
      gap: 12px;
      cursor: pointer;
      transition: background 0.2s;
    }
    
    .requirement-item:hover {
      background: #2a2a2a;
    }
    
    .requirement-gauge {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex-shrink: 0;
      border: 2px solid;
    }
    
    .requirement-gauge.not-started {
      background: transparent;
      border-color: #666;
    }
    
    .requirement-gauge.in-progress {
      background: #ff9800;
      border-color: #f57c00;
    }
    
    .requirement-gauge.implemented {
      background: #4caf50;
      border-color: #388e3c;
    }
    
    .requirement-gauge.verified {
      background: #2196f3;
      border-color: #1976d2;
    }
    
    .requirement-text {
      flex: 1;
      font-size: 14px;
      line-height: 1.5;
    }
    
    
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #888;
    }
    
    .empty-state h2 {
      font-size: 20px;
      margin-bottom: 10px;
    }
    
    .empty-requirements {
      text-align: center;
      padding: 20px;
      color: #888;
      font-size: 13px;
    }
    
    .add-requirement-btn {
      background: #0e639c;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      width: 100%;
      margin-top: 10px;
      transition: background 0.2s;
    }
    
    .add-requirement-btn:hover {
      background: #1177bb;
    }
  </style>
</head>
<body>
  <div class="search-container">
    <input 
      type="text" 
      id="search-input" 
      class="search-input" 
      placeholder="🔍 Search features and requirements..."
      autocomplete="off"
    />
  </div>
  <div class="content-wrapper">
    <div id="container">
      <div class="header">
        <h1>Dev Mode - Requirements Management</h1>
        <button class="add-feature-btn" onclick="addFeature()">+ Add Feature</button>
      </div>
      <div id="content"></div>
    </div>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    console.log('[Webview] Script loaded, vscode API acquired:', vscode);
    let currentData = null;
    let currentMenu = null;
    
    // Notify ready
    console.log('[Webview] Sending ready message');
    vscode.postMessage({ type: 'ready' });
    console.log('[Webview] Ready message sent');
    
    // Search functionality
    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('input', (e) => {
      const searchTerm = e.target.value.toLowerCase().trim();
      filterFeatures(searchTerm);
    });
    
    function filterFeatures(searchTerm) {
      const featureBlocks = document.querySelectorAll('.feature-block');
      
      if (!searchTerm) {
        // Show all features if search is empty
        featureBlocks.forEach(block => block.classList.remove('hidden'));
        return;
      }
      
      featureBlocks.forEach(block => {
        const featureName = block.querySelector('.feature-title')?.textContent?.toLowerCase() || '';
        const featureDesc = block.querySelector('.feature-description')?.textContent?.toLowerCase() || '';
        const requirements = Array.from(block.querySelectorAll('.requirement-text'))
          .map(el => el.textContent?.toLowerCase() || '')
          .join(' ');
        
        // Check if search term matches feature name, description, or any requirement
        const matches = featureName.includes(searchTerm) || 
                       featureDesc.includes(searchTerm) || 
                       requirements.includes(searchTerm);
        
        if (matches) {
          block.classList.remove('hidden');
        } else {
          block.classList.add('hidden');
        }
      });
    }
    
    window.addEventListener('message', event => {
      const message = event.data;
      
      switch (message.type) {
        case 'update':
          currentData = message.data;
          renderView();
          break;
        case 'empty':
          renderEmpty(message.message);
          break;
      }
    });
    
    function renderEmpty(message) {
      document.getElementById('content').innerHTML = \`
        <div class="empty-state">
          <h2>No Features Yet</h2>
          <p>\${message}</p>
        </div>
      \`;
    }
    
    function renderView() {
      if (!currentData || !currentData.features) {
        return;
      }
      
      const html = \`
        <div class="features-grid">
          \${currentData.features.map(feature => \`
            <div class="feature-block">
              <div class="feature-header">
                <div style="flex: 1;">
                  <h2 class="feature-title">\${feature.name}</h2>
                  \${feature.description ? \`<p class="feature-description">\${feature.description}</p>\` : ''}
                </div>
                <div class="feature-menu">
                  <button class="menu-button" onclick="toggleFeatureMenu(event, '\${feature.key}')">⋮</button>
                  <div class="context-menu" id="menu-\${feature.key}">
                    <div class="context-menu-item" onclick="addRequirement('\${feature.key}')">+ Add requirement</div>
                    \${feature.requirements.length > 0 ? \`
                      <div class="context-menu-item" onclick="validateAll('\${feature.key}')">Validate all requirements</div>
                      <div class="context-menu-separator"></div>
                    \` : ''}
                    <div class="context-menu-item" onclick="editFeature('\${feature.key}')">Edit feature</div>
                    <div class="context-menu-item" onclick="deleteFeature('\${feature.key}')">Delete feature</div>
                  </div>
                </div>
              </div>
              <div class="requirements-list">
                \${feature.requirements.length > 0 ? feature.requirements.map(req => \`
                  <div class="requirement-item" onclick="showRequirementMenu(event, '\${feature.key}', '\${req.id}')">
                    <div class="requirement-gauge \${req.status}"></div>
                    <div class="requirement-text">\${req.text}</div>
                  </div>
                \`).join('') : \`
                  <div class="empty-requirements">
                    No requirements yet
                  </div>
                \`}
              </div>
              <button class="add-requirement-btn" onclick="addRequirement('\${feature.key}')">+ Add Requirement</button>
            </div>
          \`).join('')}
        </div>
      \`;
      
      document.getElementById('content').innerHTML = html;
    }
    
    function addFeature() {
      vscode.postMessage({ type: 'feature:add' });
    }
    
    function editFeature(featureKey) {
      closeMenus();
      vscode.postMessage({ type: 'feature:edit', featureKey });
    }
    
    function deleteFeature(featureKey) {
      closeMenus();
      vscode.postMessage({ type: 'feature:delete', featureKey });
    }
    
    function addRequirement(featureKey) {
      closeMenus();
      vscode.postMessage({ type: 'requirement:add', featureKey });
    }
    
    function validateAll(featureKey) {
      closeMenus();
      vscode.postMessage({ type: 'feature:validateAll', featureKey });
    }
    
    function toggleFeatureMenu(event, featureKey) {
      event.preventDefault();
      event.stopPropagation();
      closeMenus();
      const menu = document.getElementById('menu-' + featureKey);
      if (menu) {
        menu.classList.add('show');
        currentMenu = menu;
        
        // Adjust position if menu goes off screen
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
          menu.style.right = '0';
          menu.style.left = 'auto';
        }
        if (rect.bottom > window.innerHeight) {
          menu.style.bottom = '100%';
          menu.style.top = 'auto';
        }
        
        // Close menu on outside click
        setTimeout(() => {
          document.addEventListener('click', function closeMenu(e) {
            if (currentMenu && !currentMenu.contains(e.target)) {
              closeMenus();
              document.removeEventListener('click', closeMenu);
            }
          });
        }, 0);
      }
    }
    
    function showRequirementMenu(event, featureKey, requirementId) {
      event.preventDefault();
      event.stopPropagation();
      closeMenus();
      
      // Find the requirement to get its status
      const feature = currentData.features.find(f => f.key === featureKey);
      const requirement = feature?.requirements.find(r => r.id === requirementId);
      const status = requirement?.status || 'not-started';
      
      console.log('[Webview] showRequirementMenu - status:', status, 'requirement:', requirement);
      
      // Create temporary menu
      const menu = document.createElement('div');
      menu.className = 'context-menu show';
      menu.style.position = 'fixed';
      menu.style.left = event.clientX + 'px';
      menu.style.top = event.clientY + 'px';
      
      // Show "Build" for not-started, "Validate" for others
      const actionLabel = status === 'not-started' ? 'Build' : 'Validate';
      const actionType = status === 'not-started' ? 'build' : 'validate';
      
      console.log('[Webview] Menu action - status:', status, 'actionLabel:', actionLabel, 'actionType:', actionType);
      
      // For non-not-started requirements, show "Remove from code" instead of direct delete
      let menuItems = \`
        <div class="context-menu-item" data-action="edit">Edit</div>
        <div class="context-menu-item" data-action="\${actionType}">\${actionLabel}</div>
      \`;
      
      if (status !== 'not-started') {
        menuItems += \`
          <div class="context-menu-separator"></div>
          <div class="context-menu-item" data-action="remove">Remove from code</div>
        \`;
      }
      
      menuItems += \`
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="delete">Delete</div>
      \`;
      
      menu.innerHTML = menuItems;
      
      // Add event listeners to menu items
      menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const action = item.getAttribute('data-action');
          console.log('[Webview] Menu item clicked, action:', action, 'feature:', featureKey, 'req:', requirementId);
          
          // Close menu first
          closeMenus();
          
          // Then perform action
          if (action === 'edit') {
            editRequirement(featureKey, requirementId);
          } else if (action === 'build') {
            buildRequirement(featureKey, requirementId);
          } else if (action === 'validate') {
            validateRequirement(featureKey, requirementId);
          } else if (action === 'remove') {
            removeRequirementFromCode(featureKey, requirementId);
          } else if (action === 'delete') {
            deleteRequirement(featureKey, requirementId);
          }
        });
      });
      
      document.body.appendChild(menu);
      currentMenu = menu;
      
      // Adjust position if menu goes off screen
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = (window.innerWidth - rect.width - 5) + 'px';
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = (window.innerHeight - rect.height - 5) + 'px';
      }
      
      // Close menu on outside click
      setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
          if (currentMenu && !currentMenu.contains(e.target)) {
            currentMenu.remove();
            currentMenu = null;
            document.removeEventListener('click', closeMenu);
          }
        });
      }, 0);
    }
    
    function editRequirement(featureKey, requirementId) {
      console.log('[Webview] editRequirement called:', featureKey, requirementId);
      vscode.postMessage({ type: 'requirement:edit', featureKey, requirementId });
    }
    
    function buildRequirement(featureKey, requirementId) {
      console.log('[Webview] buildRequirement called:', featureKey, requirementId);
      console.log('[Webview] About to send requirement:build message');
      vscode.postMessage({ type: 'requirement:build', featureKey, requirementId });
      console.log('[Webview] requirement:build message sent');
    }
    
    function validateRequirement(featureKey, requirementId) {
      console.log('[Webview] validateRequirement called:', featureKey, requirementId);
      vscode.postMessage({ type: 'requirement:validate', featureKey, requirementId });
    }
    
    function removeRequirementFromCode(featureKey, requirementId) {
      console.log('[Webview] removeRequirementFromCode called:', featureKey, requirementId);
      vscode.postMessage({ type: 'requirement:remove', featureKey, requirementId });
    }
    
    function deleteRequirement(featureKey, requirementId) {
      console.log('[Webview] deleteRequirement called:', featureKey, requirementId);
      vscode.postMessage({ type: 'requirement:delete', featureKey, requirementId });
      console.log('[Webview] Delete message sent');
    }
    
    function closeMenus() {
      if (currentMenu) {
        if (currentMenu.parentElement === document.body) {
          document.body.removeChild(currentMenu);
        } else {
          currentMenu.classList.remove('show');
        }
        currentMenu = null;
      }
    }
  </script>
</body>
</html>`;
  }

  private dispose() {
    DevModePanel.currentPanel = undefined;
    this.panel.dispose();
    
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}

