/**
 * Mock VS Code API for browser-based panel testing
 * 
 * This provides a browser-compatible implementation of the VS Code webview API,
 * allowing panels to be tested locally without running VS Code.
 */

export interface MockMessage {
  type: string;
  [key: string]: unknown;
}

export type MessageHandler = (message: MockMessage) => void;

/**
 * Creates a mock acquireVsCodeApi function that can be injected into webview HTML
 */
export function createMockVsCodeApiScript(mockDataScript: string): string {
  return `
    <script>
      // Mock VS Code API for local development
      (function() {
        const messageHandlers = [];
        
        // Mock vscode object
        const mockVscode = {
          postMessage: function(message) {
            console.log('[Mock VS Code] Message from webview:', message.type, message);
            
            // Handle message and potentially send response
            if (window.__handleWebviewMessage) {
              window.__handleWebviewMessage(message);
            }
          },
          getState: function() {
            const state = localStorage.getItem('__vscode_webview_state');
            return state ? JSON.parse(state) : undefined;
          },
          setState: function(state) {
            localStorage.setItem('__vscode_webview_state', JSON.stringify(state));
            return state;
          }
        };
        
        // Override acquireVsCodeApi to return our mock
        window.acquireVsCodeApi = function() {
          return mockVscode;
        };
        
        // Function to simulate messages from the extension host
        window.__postMessageToWebview = function(message) {
          console.log('[Mock VS Code] Message to webview:', message.type, message);
          window.dispatchEvent(new MessageEvent('message', { data: message }));
        };
      })();
    </script>
    <script>
      ${mockDataScript}
    </script>
  `;
}

/**
 * Generates mock data handler script for Files Map panel
 */
export function getFilesMapMockDataScript(): string {
  return `
    // Mock data for Files Map panel
    const mockGraphData = {
      nodes: [
        // Directories
        { id: 'dir:src', type: 'directory', label: 'src', path: 'src', fileCount: 5, depth: 0 },
        { id: 'dir:src/services', type: 'directory', label: 'services', path: 'src/services', fileCount: 2, depth: 1 },
        { id: 'dir:src/utils', type: 'directory', label: 'utils', path: 'src/utils', fileCount: 2, depth: 1 },
        
        // Files
        { 
          id: 'file:src/index.ts', type: 'file', label: 'index.ts', path: 'src/index.ts',
          lines: 150, lang: 'typescript', size: 4500, exportedSymbols: 5, smellScore: 15,
          smellDetails: { functionCount: 8, avgFunctionLength: 18, maxFunctionLength: 45, maxNestingDepth: 3, importCount: 6 },
          functions: ['main', 'init', 'setup', 'configure', 'run'],
          variables: ['config', 'logger'],
          types: ['AppConfig', 'Logger']
        },
        { 
          id: 'file:src/services/auth.ts', type: 'file', label: 'auth.ts', path: 'src/services/auth.ts',
          lines: 200, lang: 'typescript', size: 6000, exportedSymbols: 8, smellScore: 25,
          smellDetails: { functionCount: 12, avgFunctionLength: 15, maxFunctionLength: 35, maxNestingDepth: 4, importCount: 8 },
          functions: ['login', 'logout', 'validateToken', 'refreshToken', 'hashPassword'],
          variables: ['tokenCache', 'sessionStore'],
          types: ['User', 'Session', 'AuthConfig']
        },
        { 
          id: 'file:src/services/api.ts', type: 'file', label: 'api.ts', path: 'src/services/api.ts',
          lines: 180, lang: 'typescript', size: 5400, exportedSymbols: 6, smellScore: 20,
          smellDetails: { functionCount: 10, avgFunctionLength: 16, maxFunctionLength: 40, maxNestingDepth: 3, importCount: 5 },
          functions: ['fetch', 'post', 'put', 'delete', 'handleError'],
          variables: ['baseUrl', 'headers'],
          types: ['ApiResponse', 'ApiError']
        },
        { 
          id: 'file:src/utils/helpers.ts', type: 'file', label: 'helpers.ts', path: 'src/utils/helpers.ts',
          lines: 100, lang: 'typescript', size: 3000, exportedSymbols: 10, smellScore: 10,
          smellDetails: { functionCount: 15, avgFunctionLength: 6, maxFunctionLength: 15, maxNestingDepth: 2, importCount: 2 },
          functions: ['formatDate', 'parseJSON', 'debounce', 'throttle', 'deepClone'],
          variables: [],
          types: []
        },
        { 
          id: 'file:src/utils/logger.ts', type: 'file', label: 'logger.ts', path: 'src/utils/logger.ts',
          lines: 80, lang: 'typescript', size: 2400, exportedSymbols: 4, smellScore: 8,
          smellDetails: { functionCount: 5, avgFunctionLength: 12, maxFunctionLength: 25, maxNestingDepth: 2, importCount: 1 },
          functions: ['log', 'warn', 'error', 'debug'],
          variables: ['logLevel'],
          types: ['LogLevel']
        }
      ],
      edges: [
        // Directory containment
        { source: 'dir:src', target: 'dir:src/services', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/utils', type: 'contains' },
        { source: 'dir:src', target: 'file:src/index.ts', type: 'contains' },
        { source: 'dir:src/services', target: 'file:src/services/auth.ts', type: 'contains' },
        { source: 'dir:src/services', target: 'file:src/services/api.ts', type: 'contains' },
        { source: 'dir:src/utils', target: 'file:src/utils/helpers.ts', type: 'contains' },
        { source: 'dir:src/utils', target: 'file:src/utils/logger.ts', type: 'contains' },
        
        // File dependencies
        { source: 'file:src/index.ts', target: 'file:src/services/auth.ts', type: 'imports', weight: 3 },
        { source: 'file:src/index.ts', target: 'file:src/services/api.ts', type: 'imports', weight: 2 },
        { source: 'file:src/index.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 1 },
        { source: 'file:src/services/auth.ts', target: 'file:src/utils/helpers.ts', type: 'imports', weight: 2 },
        { source: 'file:src/services/api.ts', target: 'file:src/utils/helpers.ts', type: 'imports', weight: 3 },
        { source: 'file:src/services/api.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 1 }
      ]
    };
    
    // Handle messages from webview
    window.__handleWebviewMessage = function(message) {
      switch (message.type) {
        case 'ready':
          console.log('[Mock Data] Webview ready, sending graph data');
          setTimeout(() => {
            window.__postMessageToWebview({ type: 'graph:update', data: mockGraphData });
          }, 100);
          break;
        case 'layout:load':
          console.log('[Mock Data] Layout load requested');
          // No saved layout in mock
          break;
        case 'layout:save':
          console.log('[Mock Data] Layout save:', message.layout);
          break;
        case 'file:open':
          console.log('[Mock Data] Would open file:', message.filePath);
          alert('Would open file: ' + message.filePath);
          break;
        case 'file:copy':
          console.log('[Mock Data] Copying file path:', message.filePath);
          navigator.clipboard.writeText(message.filePath).then(() => {
            alert('Copied: ' + message.filePath);
          });
          break;
        case 'dir:unpin':
          console.log('[Mock Data] Unpinning directory:', message.dirPath);
          break;
      }
    };
  `;
}

/**
 * Generates mock data handler script for Symbol Changes panel
 */
export function getSymbolChangesMockDataScript(): string {
  return `
    // Mock data for Symbol Changes panel
    const mockSymbols = [
      {
        id: 'auth.ts:login',
        name: 'login',
        symbolType: 'function',
        filePath: 'src/services/auth.ts',
        changeType: 'modified',
        linesAdded: 5,
        linesRemoved: 2,
        timestamp: Date.now() - 60000,
        diff: '+ async function login(email: string, password: string) {\\n+   const user = await findUser(email);\\n+   if (!user) throw new AuthError("User not found");\\n-   return validatePassword(password);\\n+   return validatePassword(user, password);\\n+ }',
        comment: 'Added user lookup before password validation'
      },
      {
        id: 'api.ts:fetchData',
        name: 'fetchData',
        symbolType: 'function',
        filePath: 'src/services/api.ts',
        changeType: 'added',
        linesAdded: 15,
        linesRemoved: 0,
        timestamp: Date.now() - 120000,
        diff: '+ export async function fetchData<T>(endpoint: string): Promise<T> {\\n+   const response = await fetch(baseUrl + endpoint, { headers });\\n+   if (!response.ok) throw new ApiError(response.status);\\n+   return response.json();\\n+ }',
        comment: null
      },
      {
        id: 'helpers.ts:formatDate',
        name: 'formatDate',
        symbolType: 'function',
        filePath: 'src/utils/helpers.ts',
        changeType: 'modified',
        linesAdded: 2,
        linesRemoved: 1,
        timestamp: Date.now() - 300000,
        diff: '- return date.toISOString();\\n+ const options = { year: "numeric", month: "short", day: "numeric" };\\n+ return date.toLocaleDateString("en-US", options);',
        comment: 'Changed to human-readable format'
      },
      {
        id: 'logger.ts:debug',
        name: 'debug',
        symbolType: 'function',
        filePath: 'src/utils/logger.ts',
        changeType: 'deleted',
        linesAdded: 0,
        linesRemoved: 8,
        timestamp: Date.now() - 600000,
        diff: '- export function debug(message: string, ...args: unknown[]) {\\n-   if (logLevel <= LogLevel.DEBUG) {\\n-     console.debug("[DEBUG]", message, ...args);\\n-   }\\n- }',
        comment: 'Removed unused debug function'
      }
    ];
    
    // Handle messages from webview
    window.__handleWebviewMessage = function(message) {
      switch (message.type) {
        case 'ready':
          console.log('[Mock Data] Webview ready, sending symbol data');
          // Send symbols one by one with delays to simulate real-time updates
          mockSymbols.forEach((symbol, index) => {
            setTimeout(() => {
              window.__postMessageToWebview({ type: 'symbol:update', symbol });
            }, index * 500);
          });
          break;
        case 'clearAll':
          console.log('[Mock Data] Clear all requested');
          break;
        case 'symbol:explain':
          console.log('[Mock Data] Explain symbol:', message.symbolId);
          alert('Would explain symbol: ' + message.symbolId);
          break;
        case 'symbol:revert':
          console.log('[Mock Data] Revert symbol:', message.symbolId);
          alert('Would revert symbol: ' + message.symbolId);
          break;
        case 'openFile':
          console.log('[Mock Data] Would open file:', message.filePath, 'at line:', message.line);
          alert('Would open file: ' + message.filePath + ' at line ' + message.line);
          break;
      }
    };
  `;
}
