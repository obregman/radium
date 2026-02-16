import * as vscode from 'vscode';
import * as path from 'path';
import { GitHistoryTracker, TimelineFrame, TimelineInterval } from '../git/git-history-tracker';

/**
 * GitTimelinePanel - Visualizes git repository evolution over time
 * Similar to evolo's timeline view but integrated into VS Code
 */
export class GitTimelinePanel {
  public static currentPanel: GitTimelinePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private gitTracker: GitHistoryTracker;
  private frames: TimelineFrame[] = [];
  private currentFrame: number = 0;
  private isPlaying: boolean = false;
  private playbackSpeed: number = 1.0;
  private playbackInterval: NodeJS.Timeout | null = null;
  private interval: TimelineInterval = 'week';
  private static outputChannel: vscode.OutputChannel;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private workspaceRoot: string
  ) {
    this.panel = panel;
    this.gitTracker = new GitHistoryTracker(workspaceRoot);

    if (!GitTimelinePanel.outputChannel) {
      GitTimelinePanel.outputChannel = vscode.window.createOutputChannel('Radium Git Timeline');
    }

    this.panel.webview.onDidReceiveMessage(
      message => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.webview.html = this.getHtmlContent(extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    outputChannel: vscode.OutputChannel
  ) {
    GitTimelinePanel.outputChannel = outputChannel;
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (GitTimelinePanel.currentPanel) {
      GitTimelinePanel.currentPanel.panel.reveal(column);
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'radiumGitTimeline',
      'Git Timeline',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    GitTimelinePanel.currentPanel = new GitTimelinePanel(
      panel,
      extensionUri,
      workspaceFolders[0].uri.fsPath
    );
  }

  private log(message: string): void {
    GitTimelinePanel.outputChannel.appendLine(`[GitTimelinePanel] ${message}`);
  }

  private async handleMessage(message: any) {
    switch (message.type) {
      case 'ready':
        await this.loadTimeline();
        break;
      case 'toggle':
        this.togglePlayback();
        break;
      case 'play':
        this.startPlayback();
        break;
      case 'pause':
        this.stopPlayback();
        break;
      case 'seek':
        this.seekToFrame(message.frame);
        break;
      case 'prev':
        this.prevFrame();
        break;
      case 'next':
        this.nextFrame();
        break;
      case 'speed':
        this.setSpeed(message.value);
        break;
      case 'interval':
        await this.setInterval(message.value);
        break;
      case 'file:open':
        this.openFile(message.filePath);
        break;
    }
  }

  private async loadTimeline() {
    this.log('Loading timeline...');
    
    this.panel.webview.postMessage({
      type: 'loading',
      loading: true,
      complete: false
    });

    try {
      this.frames = await this.gitTracker.buildTimeline(this.interval);
      
      if (this.frames.length === 0) {
        this.panel.webview.postMessage({
          type: 'loading',
          loading: false,
          complete: true,
          error: 'No git history found'
        });
        return;
      }

      this.log(`Loaded ${this.frames.length} frames`);
      
      // Get date range for labels
      const dateRange = await this.gitTracker.getDateRange();
      const contributors = await this.gitTracker.getContributors();

      this.panel.webview.postMessage({
        type: 'loading',
        loading: false,
        complete: true,
        framesAvailable: this.frames.length
      });

      // Send initial frame
      this.currentFrame = 0;
      this.sendFrame(0);

      // Send timeline metadata
      this.panel.webview.postMessage({
        type: 'timeline:init',
        totalFrames: this.frames.length,
        startLabel: this.frames[0]?.label || '',
        endLabel: this.frames[this.frames.length - 1]?.label || '',
        startDate: dateRange?.start.toISOString(),
        endDate: dateRange?.end.toISOString(),
        contributors
      });
    } catch (error) {
      this.log(`Error loading timeline: ${error}`);
      this.panel.webview.postMessage({
        type: 'loading',
        loading: false,
        complete: true,
        error: String(error)
      });
    }
  }

  private sendFrame(index: number) {
    if (index < 0 || index >= this.frames.length) return;

    const frame = this.frames[index];
    const nodes = this.gitTracker.treeToNodes(frame.fileTree);

    // Get commit messages for display
    const commitMessages = frame.commits.slice(0, 5).map(c => ({
      message: c.message.substring(0, 50) + (c.message.length > 50 ? '...' : ''),
      changes: c.changes.length
    }));

    this.panel.webview.postMessage({
      type: 'frame',
      data: {
        index,
        total: this.frames.length,
        label: frame.label,
        nodes,
        stats: frame.stats,
        newFiles: frame.newFiles,
        modifiedFiles: frame.modifiedFiles,
        deletedFiles: frame.deletedFiles,
        commitMessages,
        playing: this.isPlaying,
        speed: this.playbackSpeed,
        startLabel: this.frames[0]?.label || '',
        endLabel: this.frames[this.frames.length - 1]?.label || '',
        contributors: Array.from(new Set(frame.commits.map(c => c.author)))
      }
    });
  }

  private togglePlayback() {
    if (this.isPlaying) {
      this.stopPlayback();
    } else {
      this.startPlayback();
    }
  }

  private startPlayback() {
    if (this.isPlaying) return;
    
    this.isPlaying = true;
    const intervalMs = 500 / this.playbackSpeed;

    this.playbackInterval = setInterval(() => {
      if (this.currentFrame < this.frames.length - 1) {
        this.currentFrame++;
        this.sendFrame(this.currentFrame);
      } else {
        this.stopPlayback();
      }
    }, intervalMs);

    this.sendPlaybackState();
  }

  private stopPlayback() {
    if (!this.isPlaying) return;
    
    this.isPlaying = false;
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = null;
    }

    this.sendPlaybackState();
  }

  private sendPlaybackState() {
    this.panel.webview.postMessage({
      type: 'playback',
      playing: this.isPlaying,
      speed: this.playbackSpeed,
      frame: this.currentFrame,
      total: this.frames.length
    });
  }

  private seekToFrame(frame: number) {
    if (frame < 0 || frame >= this.frames.length) return;
    
    this.currentFrame = frame;
    this.sendFrame(frame);
  }

  private prevFrame() {
    if (this.currentFrame > 0) {
      this.currentFrame--;
      this.sendFrame(this.currentFrame);
    }
  }

  private nextFrame() {
    if (this.currentFrame < this.frames.length - 1) {
      this.currentFrame++;
      this.sendFrame(this.currentFrame);
    }
  }

  private setSpeed(speed: number) {
    this.playbackSpeed = Math.max(0.1, Math.min(10, speed));
    
    // Restart playback with new speed if playing
    if (this.isPlaying) {
      this.stopPlayback();
      this.startPlayback();
    }

    this.sendPlaybackState();
  }

  private async setInterval(interval: TimelineInterval) {
    if (interval === this.interval) return;
    
    this.interval = interval;
    this.stopPlayback();
    await this.loadTimeline();
  }

  private async openFile(filePath: string) {
    const fullPath = path.join(this.workspaceRoot, filePath);
    try {
      const doc = await vscode.workspace.openTextDocument(fullPath);
      await vscode.window.showTextDocument(doc);
    } catch {
      // File might not exist anymore
      vscode.window.showWarningMessage(`File not found: ${filePath}`);
    }
  }

  private dispose() {
    this.stopPlayback();
    GitTimelinePanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private getHtmlContent(extensionUri: vscode.Uri): string {
    const nonce = this.getNonce();
    const cspSource = this.panel.webview.cspSource;

    return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https://d3js.org;">
  <title>Git Timeline</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    #header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }

    #header-left, #header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    #header-center {
      text-align: center;
    }

    #date-label {
      font-size: 18px;
      font-weight: bold;
      color: var(--vscode-textLink-foreground);
      margin: 0;
    }

    #stats {
      display: flex;
      gap: 16px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }

    .color-mode-selector, .interval-selector {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .color-mode-options, .interval-options {
      display: flex;
      background: var(--vscode-input-background);
      border-radius: 4px;
      overflow: hidden;
    }

    .color-mode-options input, .interval-options input {
      display: none;
    }

    .color-mode-options label, .interval-options label {
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      transition: all 0.2s;
    }

    .color-mode-options input:checked + label,
    .interval-options input:checked + label {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    #visualization {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    #graph-svg {
      width: 100%;
      height: 100%;
    }

    #legend-panel {
      position: absolute;
      top: 10px;
      right: 10px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 12px;
      max-width: 200px;
      max-height: 300px;
      overflow-y: auto;
      display: none;
    }

    #legend-panel.visible {
      display: block;
    }

    .legend-title {
      font-size: 12px;
      font-weight: bold;
      margin-bottom: 8px;
      color: var(--vscode-textLink-foreground);
    }

    .legend-author-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      margin-bottom: 4px;
    }

    .legend-color-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .legend-author-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .legend-author-count {
      color: var(--vscode-descriptionForeground);
    }

    #controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }

    #playback-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    #playback-controls button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      cursor: pointer;
      border-radius: 4px;
      font-size: 14px;
    }

    #playback-controls button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    #speed-display {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      min-width: 40px;
      text-align: center;
    }

    #timeline-container {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 20px;
    }

    #start-year, #end-year {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      min-width: 80px;
    }

    #start-year {
      text-align: right;
    }

    #timeline-slider {
      flex: 1;
      height: 6px;
      -webkit-appearance: none;
      background: var(--vscode-input-background);
      border-radius: 3px;
      cursor: pointer;
    }

    #timeline-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      background: var(--vscode-button-background);
      border-radius: 50%;
      cursor: pointer;
    }

    #timeline-slider.time-colored {
      background: linear-gradient(to right, #a8a8a8, #f0c674, #00e676);
    }

    #frame-info {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      min-width: 100px;
      text-align: right;
    }

    .tooltip {
      position: absolute;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px 12px;
      font-size: 12px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s;
      z-index: 1000;
      max-width: 300px;
    }

    .tooltip.visible {
      opacity: 1;
    }

    .tooltip-title {
      font-weight: bold;
      margin-bottom: 4px;
      color: var(--vscode-textLink-foreground);
    }

    .tooltip-info {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .link {
      stroke: var(--vscode-panel-border);
      stroke-opacity: 0.3;
    }

    .node-circle {
      cursor: pointer;
      stroke-width: 1.5px;
    }

    .node-circle.new-node {
      stroke: #00e676;
      stroke-width: 3px;
      animation: pulse 1s ease-in-out;
    }

    .node-circle.modified-node {
      stroke: #ffd43b;
      stroke-width: 2px;
    }

    @keyframes pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.2); }
      100% { transform: scale(1); }
    }

    .node-label {
      font-size: 10px;
      fill: var(--vscode-editor-foreground);
      pointer-events: none;
      text-anchor: middle;
    }

    .commit-message {
      fill: var(--vscode-textLink-foreground);
      font-size: 14px;
      font-weight: bold;
      text-anchor: middle;
      pointer-events: none;
      opacity: 0;
    }

    .loading-message, .empty-message {
      fill: var(--vscode-descriptionForeground);
      font-size: 16px;
      text-anchor: middle;
    }

    #loading-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }

    #loading-overlay.hidden {
      display: none;
    }

    .loading-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-textLink-foreground);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .loading-text {
      margin-top: 16px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div id="header">
    <div id="header-left">
      <div class="color-mode-selector">
        <div class="color-mode-options">
          <input type="radio" name="colorMode" id="color-none" value="none" checked>
          <label for="color-none">None</label>
          <input type="radio" name="colorMode" id="color-age" value="age">
          <label for="color-age">Age</label>
          <input type="radio" name="colorMode" id="color-heat" value="heat">
          <label for="color-heat">Heat</label>
          <input type="radio" name="colorMode" id="color-contributor" value="contributor">
          <label for="color-contributor">Author</label>
        </div>
      </div>
    </div>
    <div id="header-center">
      <h1 id="date-label">Loading...</h1>
      <div id="stats">
        <span id="stat-files">0 files</span>
        <span id="stat-lines">0 lines</span>
        <span id="stat-commits">0 commits</span>
        <span id="stat-contributors">0 contributors</span>
      </div>
    </div>
    <div id="header-right">
      <div class="interval-selector">
        <div class="interval-options">
          <input type="radio" name="interval" id="interval-day" value="day">
          <label for="interval-day">Day</label>
          <input type="radio" name="interval" id="interval-week" value="week" checked>
          <label for="interval-week">Week</label>
          <input type="radio" name="interval" id="interval-month" value="month">
          <label for="interval-month">Month</label>
        </div>
      </div>
    </div>
  </div>

  <main id="visualization">
    <div id="loading-overlay">
      <div class="loading-spinner"></div>
      <div class="loading-text">Loading git history...</div>
    </div>
    <div id="legend-panel">
      <div id="legend-content"></div>
    </div>
    <svg id="graph-svg"></svg>
  </main>

  <footer id="controls">
    <div id="playback-controls">
      <button id="btn-prev" title="Previous frame">⏮</button>
      <button id="btn-play" title="Play/Pause">▶</button>
      <button id="btn-next" title="Next frame">⏭</button>
      <span id="speed-display">1.0x</span>
      <button id="btn-slower" title="Slower">🐢</button>
      <button id="btn-faster" title="Faster">🐇</button>
    </div>

    <div id="timeline-container">
      <span id="start-year">2020</span>
      <input type="range" id="timeline-slider" min="0" max="100" value="0">
      <span id="end-year">2024</span>
    </div>

    <div id="frame-info">
      <span id="frame-counter">Frame 0 / 0</span>
    </div>
  </footer>

  <div class="tooltip" id="tooltip"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    class GitTimelineApp {
      constructor() {
        this.svg = d3.select('#graph-svg');
        this.container = null;
        this.linkGroup = null;
        this.nodeGroup = null;
        this.labelGroup = null;
        this.commitMessageGroup = null;
        this.simulation = null;
        this.zoom = null;
        this.tooltip = d3.select('#tooltip');

        this.currentNodes = [];
        this.currentLinks = [];
        this.isPlaying = false;
        this.speed = 1.0;
        this.currentFrame = 0;
        this.totalFrames = 0;
        this.colorMode = 'none';
        this.timelineStartDate = null;
        this.timelineEndDate = null;
        this.contributors = [];
        this.contributorColors = new Map();
        this.authorChangeCounts = new Map();
        this.maxChangeCount = 1;
        this.dirMaxHeat = new Map();

        this.init();
      }

      init() {
        this.setupSVG();
        this.setupControls();
        this.resize();
        window.addEventListener('resize', () => this.resize());
        vscode.postMessage({ type: 'ready' });
      }

      setupSVG() {
        this.svg.selectAll('*').remove();

        this.zoom = d3.zoom()
          .scaleExtent([0.1, 4])
          .on('zoom', (event) => {
            this.container.attr('transform', event.transform);
          });

        this.svg.call(this.zoom);

        this.container = this.svg.append('g').attr('class', 'graph-container');
        this.linkGroup = this.container.append('g').attr('class', 'links');
        this.nodeGroup = this.container.append('g').attr('class', 'nodes');
        this.labelGroup = this.container.append('g').attr('class', 'labels');
        this.commitMessageGroup = this.svg.append('g').attr('class', 'commit-messages');

        // Create force simulation
        this.simulation = d3.forceSimulation([])
          .force('link', d3.forceLink([]).id(d => d.id).distance(80).strength(0.1))
          .force('charge', d3.forceManyBody().strength(d => d.isDir ? -300 : -50).distanceMax(500))
          .force('collision', d3.forceCollide().radius(d => this.getNodeRadius(d) + 5).strength(0.7))
          .alphaDecay(0.02)
          .velocityDecay(0.4)
          .on('tick', () => this.tick());

        this.simulation.stop();
      }

      setupControls() {
        document.getElementById('btn-play').addEventListener('click', () => {
          vscode.postMessage({ type: 'toggle' });
        });

        document.getElementById('btn-prev').addEventListener('click', () => {
          vscode.postMessage({ type: 'prev' });
        });

        document.getElementById('btn-next').addEventListener('click', () => {
          vscode.postMessage({ type: 'next' });
        });

        document.getElementById('btn-slower').addEventListener('click', () => {
          const newSpeed = Math.max(0.1, this.speed / 1.5);
          vscode.postMessage({ type: 'speed', value: newSpeed });
        });

        document.getElementById('btn-faster').addEventListener('click', () => {
          const newSpeed = Math.min(10, this.speed * 1.5);
          vscode.postMessage({ type: 'speed', value: newSpeed });
        });

        document.getElementById('timeline-slider').addEventListener('input', (e) => {
          const frame = parseInt(e.target.value);
          vscode.postMessage({ type: 'seek', frame });
        });

        document.querySelectorAll('input[name="colorMode"]').forEach(radio => {
          radio.addEventListener('change', (e) => {
            this.colorMode = e.target.value;
            this.updateColorMode();
          });
        });

        document.querySelectorAll('input[name="interval"]').forEach(radio => {
          radio.addEventListener('change', (e) => {
            vscode.postMessage({ type: 'interval', value: e.target.value });
          });
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
          switch (e.key) {
            case ' ':
              e.preventDefault();
              vscode.postMessage({ type: 'toggle' });
              break;
            case 'ArrowLeft':
              vscode.postMessage({ type: 'prev' });
              break;
            case 'ArrowRight':
              vscode.postMessage({ type: 'next' });
              break;
            case 'ArrowUp':
              vscode.postMessage({ type: 'speed', value: Math.min(10, this.speed * 1.5) });
              break;
            case 'ArrowDown':
              vscode.postMessage({ type: 'speed', value: Math.max(0.1, this.speed / 1.5) });
              break;
          }
        });
      }

      resize() {
        const container = document.getElementById('visualization');
        this.width = container.clientWidth || 800;
        this.height = container.clientHeight || 600;
        this.svg.attr('width', this.width).attr('height', this.height);

        if (this.simulation && this.currentNodes.length > 0) {
          this.simulation.alpha(0.1).restart();
        }
      }

      handleMessage(msg) {
        switch (msg.type) {
          case 'frame':
            this.handleFrame(msg.data);
            break;
          case 'playback':
            this.handlePlaybackState(msg);
            break;
          case 'loading':
            this.handleLoadingState(msg);
            break;
          case 'timeline:init':
            this.handleTimelineInit(msg);
            break;
        }
      }

      handleLoadingState(msg) {
        const overlay = document.getElementById('loading-overlay');
        if (msg.loading) {
          overlay.classList.remove('hidden');
        } else {
          overlay.classList.add('hidden');
          if (msg.error) {
            this.showEmpty(msg.error);
          }
        }
      }

      handleTimelineInit(msg) {
        this.totalFrames = msg.totalFrames;
        this.contributors = msg.contributors || [];

        if (msg.startDate && msg.endDate) {
          this.timelineStartDate = new Date(msg.startDate);
          this.timelineEndDate = new Date(msg.endDate);
        }

        document.getElementById('start-year').textContent = msg.startLabel;
        document.getElementById('end-year').textContent = msg.endLabel;
      }

      handleFrame(data) {
        this.currentFrame = data.index;
        this.totalFrames = data.total;
        this.isPlaying = data.playing;
        this.speed = data.speed;

        // Update timeline labels
        if (data.startLabel && data.endLabel) {
          document.getElementById('start-year').textContent = data.startLabel;
          document.getElementById('end-year').textContent = data.endLabel;
        }

        // Update contributors
        if (data.contributors) {
          data.contributors.forEach(c => {
            if (!this.contributors.includes(c)) {
              this.contributors.push(c);
            }
          });
        }

        // Update header
        document.getElementById('date-label').textContent = data.label;

        // Update stats
        document.getElementById('stat-files').textContent = this.formatNumber(data.stats.totalFiles) + ' files';
        document.getElementById('stat-lines').textContent = this.formatNumber(data.stats.totalLines) + ' lines';
        document.getElementById('stat-commits').textContent = this.formatNumber(data.stats.totalCommits) + ' commits';
        document.getElementById('stat-contributors').textContent = this.formatNumber(data.stats.totalContributors) + ' contributors';

        // Update visualization
        if (data.nodes && data.nodes.length > 0) {
          this.update(data.nodes, data.newFiles, data.modifiedFiles, data.commitMessages);
          this.updateAuthorChangeCounts(data.nodes);
          this.updateLegend(data.nodes);
        }

        this.updateControls();
      }

      handlePlaybackState(msg) {
        this.isPlaying = msg.playing;
        this.speed = msg.speed;
        this.currentFrame = msg.frame;
        this.totalFrames = msg.total;
        this.updateControls();
      }

      updateControls() {
        const playBtn = document.getElementById('btn-play');
        playBtn.textContent = this.isPlaying ? '⏸' : '▶';
        playBtn.title = this.isPlaying ? 'Pause' : 'Play';

        document.getElementById('speed-display').textContent = this.speed.toFixed(1) + 'x';

        const slider = document.getElementById('timeline-slider');
        slider.max = this.totalFrames - 1;
        slider.value = this.currentFrame;

        document.getElementById('frame-counter').textContent = 
          'Frame ' + (this.currentFrame + 1) + ' / ' + this.totalFrames;
      }

      update(nodes, newFiles = [], modifiedFiles = [], commitMessages = []) {
        if (!nodes || nodes.length === 0) {
          this.showEmpty();
          return;
        }

        const newFileSet = new Set(newFiles || []);
        const modifiedFileSet = new Set(modifiedFiles || []);

        const { processedNodes, links } = this.processData(nodes, newFileSet, modifiedFileSet);

        this.simulation.nodes(processedNodes);
        this.simulation.force('link').links(links);

        this.updateLinks(links);
        this.updateNodes(processedNodes, newFileSet, modifiedFileSet);
        this.updateLabels(processedNodes);
        this.displayCommitMessages(commitMessages || []);

        const existingIds = new Set(this.currentNodes.map(n => n.id));
        const newNodeCount = processedNodes.filter(n => !existingIds.has(n.id)).length;

        const baseAlpha = 0.3;
        const alphaBoost = Math.min(0.3, newNodeCount * 0.01);
        this.simulation.alpha(baseAlpha + alphaBoost).restart();

        this.currentNodes = processedNodes;
        this.currentLinks = links;

        if (this.colorMode === 'heat') {
          this.updateHeatScale();
        }

        setTimeout(() => this.fitToView(), 500);
      }

      processData(nodes, newFileSet, modifiedFileSet) {
        const nodeMap = new Map();
        const processedNodes = [];
        const links = [];

        // Create root node
        const existingRoot = this.currentNodes.find(n => n.id === 'root');
        const rootNode = {
          id: 'root',
          name: 'Repository',
          isDir: true,
          depth: 0,
          files: nodes.filter(n => !n.isDir).length,
          x: existingRoot?.x || this.width / 2,
          y: existingRoot?.y || this.height / 2,
          fx: this.width / 2,
          fy: this.height / 2
        };
        nodeMap.set('root', rootNode);
        processedNodes.push(rootNode);

        // Process nodes
        nodes.forEach(node => {
          const existing = this.currentNodes.find(n => n.id === node.id);
          
          let newX, newY;
          if (existing) {
            newX = existing.x;
            newY = existing.y;
          } else {
            const parentId = node.parent || 'root';
            const parent = nodeMap.get(parentId) || this.currentNodes.find(n => n.id === parentId) || rootNode;
            const parentX = parent?.x || this.width / 2;
            const parentY = parent?.y || this.height / 2;
            const angle = Math.random() * Math.PI * 2;
            const distance = node.isDir ? 60 : 30;
            newX = parentX + Math.cos(angle) * distance;
            newY = parentY + Math.sin(angle) * distance;
          }

          const processedNode = {
            ...node,
            isNew: newFileSet.has(node.path),
            isModified: modifiedFileSet.has(node.path),
            x: newX,
            y: newY
          };

          nodeMap.set(node.id, processedNode);
          processedNodes.push(processedNode);
        });

        // Create links
        nodes.forEach(node => {
          const parentId = node.parent || 'root';
          if (nodeMap.has(parentId)) {
            links.push({
              source: parentId,
              target: node.id
            });
          }
        });

        return { processedNodes, links };
      }

      updateLinks(links) {
        this.linkGroup.selectAll('.link').remove();

        this.linkGroup.selectAll('.link')
          .data(links)
          .enter()
          .append('line')
          .attr('class', 'link');
      }

      updateNodes(nodes, newFileSet, modifiedFileSet) {
        this.nodeGroup.selectAll('.node').remove();

        const nodeEnter = this.nodeGroup.selectAll('.node')
          .data(nodes)
          .enter()
          .append('g')
          .attr('class', 'node')
          .attr('transform', d => 'translate(' + (d.x || 0) + ',' + (d.y || 0) + ')');

        nodeEnter.append('circle')
          .attr('class', d => {
            let cls = 'node-circle';
            if (d.isNew || newFileSet.has(d.path)) cls += ' new-node';
            else if (d.isModified || modifiedFileSet.has(d.path)) cls += ' modified-node';
            return cls;
          })
          .attr('r', d => this.getNodeRadius(d))
          .attr('fill', d => this.getNodeColor(d))
          .attr('stroke', d => this.getNodeStroke(d))
          .attr('stroke-width', d => d.id === 'root' ? 3 : (d.isDir ? 1.5 : 1))
          .style('filter', d => d.id === 'root' ? 'drop-shadow(0 0 8px #FFD700)' : null);

        const allNodes = this.nodeGroup.selectAll('.node');

        allNodes.call(d3.drag()
          .on('start', (event, d) => this.dragStarted(event, d))
          .on('drag', (event, d) => this.dragged(event, d))
          .on('end', (event, d) => this.dragEnded(event, d)));

        allNodes
          .on('mouseenter', (event, d) => this.showTooltip(event, d))
          .on('mousemove', (event) => this.moveTooltip(event))
          .on('mouseleave', () => this.hideTooltip())
          .on('click', (event, d) => {
            if (!d.isDir && d.path) {
              vscode.postMessage({ type: 'file:open', filePath: d.path });
            }
          });
      }

      updateLabels(nodes) {
        this.labelGroup.selectAll('.node-label').remove();

        const labelNodes = nodes.filter(d => d.isDir && d.id !== 'root');

        this.labelGroup.selectAll('.node-label')
          .data(labelNodes)
          .enter()
          .append('text')
          .attr('class', 'node-label')
          .attr('x', d => d.x || 0)
          .attr('y', d => (d.y || 0) + this.getNodeRadius(d) + 12)
          .text(d => this.truncateName(d.name, 12));
      }

      displayCommitMessages(commitMessages) {
        if (!commitMessages || commitMessages.length === 0) return;

        const centerX = this.width / 2;
        const centerY = this.height / 2;
        const clusterRadius = Math.min(this.width, this.height) * 0.3;

        commitMessages.slice(0, 3).forEach((commit, index) => {
          const angle = Math.random() * Math.PI * 2;
          const distance = clusterRadius * (0.8 + Math.random() * 0.4);
          const x = centerX + Math.cos(angle) * distance;
          const y = centerY + Math.sin(angle) * distance;
          const delay = index * 200;

          const text = this.commitMessageGroup.append('text')
            .attr('class', 'commit-message')
            .attr('x', x)
            .attr('y', y)
            .attr('opacity', 0)
            .text(commit.message);

          text.transition()
            .delay(delay)
            .duration(400)
            .attr('opacity', 0.8)
            .transition()
            .duration(1200)
            .attr('y', y - 20)
            .transition()
            .duration(400)
            .attr('opacity', 0)
            .remove();
        });
      }

      tick() {
        this.linkGroup.selectAll('.link')
          .attr('x1', d => d.source?.x || 0)
          .attr('y1', d => d.source?.y || 0)
          .attr('x2', d => d.target?.x || 0)
          .attr('y2', d => d.target?.y || 0);

        this.nodeGroup.selectAll('.node')
          .attr('transform', d => 'translate(' + (d.x || 0) + ',' + (d.y || 0) + ')');

        this.labelGroup.selectAll('.node-label')
          .attr('x', d => d.x || 0)
          .attr('y', d => (d.y || 0) + this.getNodeRadius(d) + 12);
      }

      fitToView() {
        if (!this.currentNodes || this.currentNodes.length === 0) return;

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        this.currentNodes.forEach(node => {
          if (node.x !== undefined && node.y !== undefined) {
            const r = this.getNodeRadius(node);
            minX = Math.min(minX, node.x - r);
            maxX = Math.max(maxX, node.x + r);
            minY = Math.min(minY, node.y - r);
            maxY = Math.max(maxY, node.y + r);
          }
        });

        if (minX === Infinity) return;

        const padding = 50;
        minX -= padding;
        maxX += padding;
        minY -= padding;
        maxY += padding;

        const boxWidth = maxX - minX;
        const boxHeight = maxY - minY;

        if (boxWidth <= 0 || boxHeight <= 0) return;

        const scale = Math.min(this.width / boxWidth, this.height / boxHeight, 1.5);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const translateX = this.width / 2 - centerX * scale;
        const translateY = this.height / 2 - centerY * scale;

        this.svg.transition()
          .duration(400)
          .call(this.zoom.transform, d3.zoomIdentity.translate(translateX, translateY).scale(scale));
      }

      getNodeRadius(d) {
        if (!d) return 4;
        if (d.id === 'root') return 30;
        if (d.isDir) return Math.max(8, Math.min(16, 6 + Math.sqrt(d.files || 1) * 1.5));
        return 4;
      }

      getNodeColor(d) {
        if (!d) return '#99c1f1';
        if (d.id === 'root') return '#FFD700';

        if (this.colorMode === 'age' && this.timelineStartDate && this.timelineEndDate && d.addedAt) {
          const addedTime = new Date(d.addedAt).getTime();
          const startTime = this.timelineStartDate.getTime();
          const endTime = this.timelineEndDate.getTime();
          const ratio = (addedTime - startTime) / (endTime - startTime);
          return d3.interpolateRgb('#a8a8a8', '#00e676')(ratio);
        }

        if (this.colorMode === 'heat' && d.changeCount) {
          const ratio = Math.min(1, d.changeCount / this.maxChangeCount);
          return d3.interpolateRgb('#58a6ff', '#e06c75')(ratio);
        }

        if (this.colorMode === 'contributor' && d.lastAuthor) {
          return this.getContributorColor(d.lastAuthor);
        }

        if (d.isDir) {
          const colors = ['#3584e4', '#2e75cc', '#2666b4', '#1e579c', '#164884'];
          return colors[Math.min(d.depth || 0, colors.length - 1)];
        }
        return '#99c1f1';
      }

      getNodeStroke(d) {
        if (!d) return '#62a0ea';
        if (d.id === 'root') return '#FFA500';
        if (d.isDir) return '#1a5fb4';
        return '#62a0ea';
      }

      getContributorColor(name) {
        if (this.contributorColors.has(name)) {
          return this.contributorColors.get(name);
        }

        const colors = [
          '#e06c75', '#f87171', '#fb7185', '#be5046',
          '#d19a66', '#fb923c', '#f97316', '#ea580c',
          '#e5c07b', '#fbbf24', '#facc15', '#eab308',
          '#98c379', '#4ade80', '#22c55e', '#16a34a',
          '#56b6c2', '#2dd4bf', '#14b8a6', '#0d9488',
          '#61afef', '#60a5fa', '#3b82f6', '#2563eb',
          '#818cf8', '#6366f1', '#4f46e5', '#4338ca',
          '#c678dd', '#a78bfa', '#8b5cf6', '#7c3aed',
          '#f472b6', '#ec4899', '#db2777', '#be185d'
        ];

        let hash = 0;
        for (let i = 0; i < name.length; i++) {
          hash = ((hash << 5) - hash) + name.charCodeAt(i);
          hash = hash & hash;
        }

        const color = colors[Math.abs(hash) % colors.length];
        this.contributorColors.set(name, color);
        return color;
      }

      updateColorMode() {
        const slider = document.getElementById('timeline-slider');
        slider.classList.remove('time-colored');
        if (this.colorMode === 'age') {
          slider.classList.add('time-colored');
        }

        if (this.colorMode === 'heat') {
          this.updateHeatScale();
        }

        this.nodeGroup.selectAll('.node-circle')
          .attr('fill', d => this.getNodeColor(d))
          .attr('stroke', d => this.getNodeStroke(d));

        this.updateLegend(this.currentNodes);
      }

      updateHeatScale() {
        this.maxChangeCount = 1;
        this.currentNodes.forEach(node => {
          if (!node.isDir && node.changeCount && node.changeCount > this.maxChangeCount) {
            this.maxChangeCount = node.changeCount;
          }
        });
      }

      updateAuthorChangeCounts(nodes) {
        this.authorChangeCounts.clear();
        if (!nodes) return;

        nodes.forEach(node => {
          if (node.lastAuthor && !node.isDir) {
            const current = this.authorChangeCounts.get(node.lastAuthor) || 0;
            this.authorChangeCounts.set(node.lastAuthor, current + 1);
          }
        });
      }

      updateLegend(nodes) {
        const panel = document.getElementById('legend-panel');
        const content = document.getElementById('legend-content');

        if (this.colorMode === 'none' || this.colorMode === 'age') {
          panel.classList.remove('visible');
          return;
        }

        panel.classList.add('visible');

        if (this.colorMode === 'contributor') {
          const sorted = Array.from(this.authorChangeCounts.entries())
            .sort((a, b) => b[1] - a[1]);

          let html = '<div class="legend-title">Last Author (files)</div>';
          sorted.forEach(([author, count]) => {
            const color = this.getContributorColor(author);
            html += '<div class="legend-author-item">' +
              '<span class="legend-color-dot" style="background: ' + color + '"></span>' +
              '<span class="legend-author-name" title="' + author + '">' + author + '</span>' +
              '<span class="legend-author-count">' + count + '</span>' +
            '</div>';
          });
          content.innerHTML = html;
        } else if (this.colorMode === 'heat') {
          content.innerHTML = '<div class="legend-title">Change Frequency</div>' +
            '<div style="display: flex; align-items: center; gap: 8px;">' +
              '<span style="font-size: 11px;">Low</span>' +
              '<div style="flex: 1; height: 10px; background: linear-gradient(to right, #58a6ff, #e06c75); border-radius: 2px;"></div>' +
              '<span style="font-size: 11px;">High</span>' +
            '</div>';
        }
      }

      showTooltip(event, d) {
        if (!d || d.id === 'root') return;

        let info = (d.isDir ? 'Directory' : 'File') + '<br>' +
          (d.files || 0) + ' files | ' + this.formatNumber(d.lines || 0) + ' lines';

        if (this.colorMode === 'heat' && d.changeCount) {
          info += '<br>Changes: ' + d.changeCount;
        }
        if (this.colorMode === 'contributor' && d.lastAuthor) {
          info += '<br>Author: ' + d.lastAuthor;
        }

        this.tooltip
          .style('display', 'block')
          .classed('visible', true)
          .html('<div class="tooltip-title">' + (d.name || 'Unknown') + '</div>' +
                '<div class="tooltip-info">' + info + '</div>');
        this.moveTooltip(event);
      }

      moveTooltip(event) {
        this.tooltip
          .style('left', (event.pageX + 12) + 'px')
          .style('top', (event.pageY - 8) + 'px');
      }

      hideTooltip() {
        this.tooltip.classed('visible', false).style('display', 'none');
      }

      showEmpty(message = 'No data to display') {
        this.simulation?.stop();
        this.linkGroup?.selectAll('*').remove();
        this.nodeGroup?.selectAll('*').remove();
        this.labelGroup?.selectAll('*').remove();
        this.currentNodes = [];
        this.currentLinks = [];

        this.container.selectAll('.empty-message').remove();
        this.container.append('text')
          .attr('class', 'empty-message')
          .attr('x', this.width / 2)
          .attr('y', this.height / 2)
          .text(message);
      }

      dragStarted(event, d) {
        if (!event.active) this.simulation.alphaTarget(0.2).restart();
        d.fx = d.x;
        d.fy = d.y;
      }

      dragged(event, d) {
        d.fx = event.x;
        d.fy = event.y;
      }

      dragEnded(event, d) {
        if (!event.active) this.simulation.alphaTarget(0);
        if (d.id !== 'root') {
          d.fx = null;
          d.fy = null;
        }
      }

      truncateName(name, maxLen) {
        if (!name) return '';
        if (name.length <= maxLen) return name;
        return name.substring(0, maxLen - 1) + '…';
      }

      formatNumber(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return n.toString();
      }
    }

    const app = new GitTimelineApp();

    window.addEventListener('message', event => {
      app.handleMessage(event.data);
    });
  </script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
