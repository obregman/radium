/**
 * Semantic Change Analyzer
 * 
 * Analyzes code diffs to detect semantic changes by category:
 * - Logic change: Modified conditionals, loops, operators, return statements
 * - Add logic: New control flow structures
 * - Delete code: Removed lines containing logic
 * - Read from external source: File I/O, database queries, config reads
 * - Call an API: HTTP requests, GraphQL, gRPC, WebSocket
 * - Expose an API: Route definitions, endpoint decorators, API exports
 */

export type SemanticChangeCategory = 
  | 'logic_change'
  | 'add_logic'
  | 'delete_code'
  | 'read_external'
  | 'call_api'
  | 'expose_api'
  | 'add_function'
  | 'delete_function';

export interface SemanticChange {
  category: SemanticChangeCategory;
  filePath: string;
  lineNumber: number;
  lineContent: string;
  description: string;
  context?: string; // Additional context about the change
  comments?: string[]; // Extracted comments from the change
  functionName?: string; // Name of the function where the change occurred
}

export interface DiffLine {
  type: 'added' | 'deleted' | 'context';
  lineNumber: number;
  content: string;
}

export class SemanticAnalyzer {
  // Pattern definitions for each category
  private static readonly LOGIC_CHANGE_PATTERNS = [
    /\b(if|else|while|for|switch|return)\b/,
    /[&|!]=|[<>]=?|===?|!==?/,  // Operators
    /\b(and|or|not)\b/i,  // Logical operators (Python, etc.)
    /[?:]/,  // Ternary operator
  ];

  private static readonly ADD_LOGIC_PATTERNS = [
    /^\+.*\b(if|else if|elif)\s*\(/,
    /^\+.*\b(for|while)\s*\(/,
    /^\+.*\bswitch\s*\(/,
    /^\+.*\b(try|catch|except|finally)\s*[{:]/,
    /^\+.*\breturn\b/,
  ];

  private static readonly ADD_FUNCTION_PATTERNS = [
    // JavaScript/TypeScript
    /^\+.*\b(function|async function)\s+\w+\s*\(/,
    /^\+.*\b(const|let|var)\s+\w+\s*=\s*(async\s+)?\([^)]*\)\s*=>/,
    /^\+.*\b\w+\s*\([^)]*\)\s*\{/,  // Method definition
    // Python
    /^\+.*\bdef\s+\w+\s*\(/,
    /^\+.*\basync\s+def\s+\w+\s*\(/,
    // Java/C#/C++ - Enhanced to support multiple modifiers and generic return types
    // Matches: [modifiers...] returnType methodName(
    // Where returnType can include generics like Task<T> or List<Item>
    /^\+.*\b(public|private|protected|internal|static|async|virtual|override|sealed|abstract|readonly|extern)(?:\s+(?:public|private|protected|internal|static|async|virtual|override|sealed|abstract|readonly|extern))*\s+(?:.+?)\s+\w+\s*\(/,
    // Go
    /^\+.*\bfunc\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/,
    // Ruby
    /^\+.*\bdef\s+\w+/,
    // PHP
    /^\+.*\bfunction\s+\w+\s*\(/,
  ];

  private static readonly DELETE_FUNCTION_PATTERNS = [
    // JavaScript/TypeScript
    /^-.*\b(function|async function)\s+\w+\s*\(/,
    /^-.*\b(const|let|var)\s+\w+\s*=\s*(async\s+)?\([^)]*\)\s*=>/,
    /^-.*\b\w+\s*\([^)]*\)\s*\{/,  // Method definition
    // Python
    /^-.*\bdef\s+\w+\s*\(/,
    /^-.*\basync\s+def\s+\w+\s*\(/,
    // Java/C#/C++ - Enhanced to support multiple modifiers and generic return types
    // Matches: [modifiers...] returnType methodName(
    // Where returnType can include generics like Task<T> or List<Item>
    /^-.*\b(public|private|protected|internal|static|async|virtual|override|sealed|abstract|readonly|extern)(?:\s+(?:public|private|protected|internal|static|async|virtual|override|sealed|abstract|readonly|extern))*\s+(?:.+?)\s+\w+\s*\(/,
    // Go
    /^-.*\bfunc\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/,
    // Ruby
    /^-.*\bdef\s+\w+/,
    // PHP
    /^-.*\bfunction\s+\w+\s*\(/,
  ];

  private static readonly READ_EXTERNAL_PATTERNS = [
    // File I/O
    /\b(fs\.|readFile|readFileSync|open|File|loadFile|read|load)\s*\(/,
    /\b(fopen|fread|file_get_contents|readfile)\s*\(/,  // PHP, C
    /\bwith\s+open\s*\(/,  // Python
    /\b(File\.|Directory\.|Path\.)(ReadAllText|ReadAllLines|ReadAllBytes|Exists|Open|Create)\s*\(/,  // C# File I/O
    /\b(StreamReader|FileStream|BinaryReader)\s*\(/,  // C# Streams
    // Database
    /\b(SELECT|INSERT|UPDATE|DELETE)\b/i,
    /\.(find|findOne|findMany|query|get|fetch|select)\s*\(/,
    /\b(db\.|collection\.|model\.)/,
    /\b(execute|executeQuery|rawQuery|ExecuteReader|ExecuteScalar|ExecuteNonQuery)\s*\(/,  // C# ADO.NET
    /\b(FromSql|FromSqlRaw|ExecuteSqlCommand)\s*\(/,  // Entity Framework
    // Config
    /\bprocess\.env\./,
    /\b(config\.|getConfig|loadConfig)\s*\(/,
    /\brequire\s*\(\s*['"]config['"]/,
    /\bimport\s+.*\s+from\s+['"].*config/,
    /\b(ConfigurationManager|IConfiguration)\./,  // C# Configuration
  ];

  private static readonly CALL_API_PATTERNS = [
    // HTTP
    /\b(fetch|axios|http|https)\s*\(/,
    /\.(get|post|put|patch|delete|request)\s*\(/,
    /\$\.ajax\s*\(/,
    /\bnew\s+(XMLHttpRequest|Request)\s*\(/,
    /\b(HttpClient|WebClient|RestClient)\./,  // C# HTTP clients
    /\.(GetAsync|PostAsync|PutAsync|DeleteAsync|SendAsync)\s*\(/,  // C# async HTTP methods
    /\bnew\s+(HttpRequestMessage|RestRequest)\s*\(/,  // C# HTTP request objects
    // GraphQL
    /\b(graphql|query|mutation)\s*\(/,
    /\buseQuery|useMutation\s*\(/,
    // gRPC
    /\.call\s*\(/,
    /\bgrpc\./,
    // WebSocket
    /\bnew\s+WebSocket\s*\(/,
    /\b(ws|socket)\.(send|emit)\s*\(/,
    /\b(ClientWebSocket|WebSocketClient)\./,  // C# WebSocket
  ];

  private static readonly EXPOSE_API_PATTERNS = [
    // Routes
    /\b(app|router|server)\.(get|post|put|patch|delete|use|route)\s*\(/,
    /\.(Get|Post|Put|Patch|Delete|Route)\s*\(/,
    /\[Http(Get|Post|Put|Patch|Delete)\]/,  // C# HTTP attribute routing
    /\[Route\s*\(/,  // C# Route attribute
    /@(Get|Post|Put|Patch|Delete|Route|Api|Controller|RequestMapping)\s*\(/,
    // Exports
    /\bexport\s+(function|class|const|let|var|default)/,
    /\bmodule\.exports\s*=/,
    /\bexports\./,
    /\bpublic\s+(class|interface|enum)\s+\w+\s*:\s*(Controller|ApiController)/,  // C# API Controllers
    // API decorators
    /@(api|endpoint|route|controller)\b/i,
    /\[ApiController\]/,  // C# API Controller attribute
  ];

  /**
   * Analyze a diff to detect semantic changes
   */
  public analyzeDiff(filePath: string, diff: string): SemanticChange[] {
    const changes: SemanticChange[] = [];
    const lines = diff.split('\n');
    
    let currentLineNumber = 0;
    let inHunk = false;
    let currentFunctionContext = ''; // Track the function context from hunk headers
    
    // First pass: collect all additions and deletions to distinguish modifications from pure deletions
    const deletions = new Map<number, string>(); // line index -> content
    const additions = new Set<number>(); // line indices with additions
    const extractedComments: string[] = []; // Collect comments from added lines
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions.add(i);
        // Extract comments from added lines
        const content = line.substring(1);
        const comment = this.extractComment(content);
        if (comment) {
          extractedComments.push(comment);
        }
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions.set(i, line.substring(1));
      }
    }
    
    // Second pass: analyze changes
    currentLineNumber = 0;
    inHunk = false;
    currentFunctionContext = '';
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Parse hunk headers to track line numbers and function context
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@\s*(.*)/);
        if (match) {
          currentLineNumber = parseInt(match[1], 10);
          inHunk = true;
          // Extract function context from hunk header (text after the second @@)
          const hunkContext = match[2] || '';
          currentFunctionContext = this.extractFunctionNameFromContext(hunkContext);
          console.log(`[SemanticAnalyzer] Hunk header: "${line}"`);
          console.log(`[SemanticAnalyzer] Hunk context: "${hunkContext}" -> function: "${currentFunctionContext}"`);
        }
        continue;
      }
      
      if (!inHunk) continue;
      
      // Skip file headers
      if (line.startsWith('---') || line.startsWith('+++')) {
        continue;
      }
      
      const lineType = this.getLineType(line);
      const content = line.substring(1); // Remove +/- prefix
      
      if (lineType === 'added') {
        let detectedAny = false;
        const changesBeforeCount = changes.length;
        
        // Check for added functions (highest priority)
        const addedFunctions = this.detectAddedFunctions(filePath, currentLineNumber, content);
        if (addedFunctions.length > 0) {
          changes.push(...addedFunctions);
          detectedAny = true;
        }
        
        // Check for added logic patterns
        const addedChanges = this.detectAddedLogic(filePath, currentLineNumber, content);
        if (addedChanges.length > 0) {
          changes.push(...addedChanges);
          detectedAny = true;
        }
        
        // Check for API calls
        const apiCalls = this.detectApiCalls(filePath, currentLineNumber, content);
        if (apiCalls.length > 0) {
          changes.push(...apiCalls);
          detectedAny = true;
        }
        
        // Check for external reads
        const externalReads = this.detectExternalReads(filePath, currentLineNumber, content);
        if (externalReads.length > 0) {
          changes.push(...externalReads);
          detectedAny = true;
        }
        
        // Check for exposed APIs
        const exposedApis = this.detectExposedApis(filePath, currentLineNumber, content);
        if (exposedApis.length > 0) {
          changes.push(...exposedApis);
          detectedAny = true;
        }
        
        // Check for logic changes (modified patterns)
        const logicChanges = this.detectLogicChanges(filePath, currentLineNumber, content, lines, i);
        if (logicChanges.length > 0) {
          changes.push(...logicChanges);
          detectedAny = true;
        }
        
        // If no specific pattern matched but line has meaningful content, add as generic "add_logic"
        if (!detectedAny && content.trim().length > 0 && !this.isEmptyOrComment(content)) {
          changes.push({
            category: 'add_logic',
            filePath,
            lineNumber: currentLineNumber,
            lineContent: content,
            description: 'Code added',
            context: this.extractContext(content)
          });
        }
        
        // Add function context to all changes detected in this iteration
        if (currentFunctionContext) {
          for (let j = changesBeforeCount; j < changes.length; j++) {
            changes[j].functionName = currentFunctionContext;
          }
        }
        
        currentLineNumber++;
      } else if (lineType === 'deleted') {
        // Check if there are additions within 3 lines (before or after)
        const hasNearbyAdditions = this.hasNearbyAdditions(additions, i, 3);
        
        if (!hasNearbyAdditions && content.trim().length > 0) {
          // This is a pure deletion, not part of a modification
          const changesBeforeCount = changes.length;
          
          // Check if it's a deleted function (highest priority)
          const deletedFunctions = this.detectDeletedFunctions(filePath, currentLineNumber, content);
          if (deletedFunctions.length > 0) {
            changes.push(...deletedFunctions);
          } else {
            // Otherwise, it's a generic code deletion
            changes.push({
              category: 'delete_code',
              filePath,
              lineNumber: currentLineNumber,
              lineContent: content,
              description: 'Code deleted',
              context: this.extractContext(content)
            });
          }
          
          // Add function context to deletion changes
          if (currentFunctionContext) {
            for (let j = changesBeforeCount; j < changes.length; j++) {
              changes[j].functionName = currentFunctionContext;
            }
          }
        }
      } else {
        // Context line
        currentLineNumber++;
      }
    }
    
    const deduped = this.deduplicateChanges(changes);
    
    // Add extracted comments to all changes
    if (extractedComments.length > 0) {
      deduped.forEach(change => {
        change.comments = extractedComments;
      });
    }
    
    return deduped;
  }

  /**
   * Detect added functions
   */
  private detectAddedFunctions(filePath: string, lineNumber: number, content: string): SemanticChange[] {
    const changes: SemanticChange[] = [];
    
    for (const pattern of SemanticAnalyzer.ADD_FUNCTION_PATTERNS) {
      if (pattern.test('+' + content)) {
        const functionName = this.extractFunctionName(content);
        changes.push({
          category: 'add_function',
          filePath,
          lineNumber,
          lineContent: content,
          description: functionName ? `Function "${functionName}" added` : 'Function added',
          context: this.extractContext(content)
        });
        break; // Only add once per line
      }
    }
    
    return changes;
  }

  /**
   * Detect deleted functions
   */
  private detectDeletedFunctions(filePath: string, lineNumber: number, content: string): SemanticChange[] {
    const changes: SemanticChange[] = [];
    
    for (const pattern of SemanticAnalyzer.DELETE_FUNCTION_PATTERNS) {
      if (pattern.test('-' + content)) {
        const functionName = this.extractFunctionName(content);
        changes.push({
          category: 'delete_function',
          filePath,
          lineNumber,
          lineContent: content,
          description: functionName ? `Function "${functionName}" deleted` : 'Function deleted',
          context: this.extractContext(content)
        });
        break; // Only add once per line
      }
    }
    
    return changes;
  }

  /**
   * Detect added logic patterns
   */
  private detectAddedLogic(filePath: string, lineNumber: number, content: string): SemanticChange[] {
    const changes: SemanticChange[] = [];
    
    for (const pattern of SemanticAnalyzer.ADD_LOGIC_PATTERNS) {
      if (pattern.test('+' + content)) {
        const description = this.describeAddedLogic(content);
        changes.push({
          category: 'add_logic',
          filePath,
          lineNumber,
          lineContent: content,
          description,
          context: this.extractContext(content)
        });
        break; // Only add once per line
      }
    }
    
    return changes;
  }

  /**
   * Detect logic changes (modifications to existing logic)
   */
  private detectLogicChanges(
    filePath: string,
    lineNumber: number,
    content: string,
    allLines: string[],
    currentIndex: number
  ): SemanticChange[] {
    const changes: SemanticChange[] = [];
    
    // Look for patterns that indicate logic modification
    for (const pattern of SemanticAnalyzer.LOGIC_CHANGE_PATTERNS) {
      if (pattern.test(content)) {
        // Check if there's a corresponding deletion nearby (indicating modification)
        const hasNearbyDeletion = this.hasNearbyDeletion(allLines, currentIndex);
        
        if (hasNearbyDeletion) {
          const description = this.describeLogicChange(content);
          changes.push({
            category: 'logic_change',
            filePath,
            lineNumber,
            lineContent: content,
            description,
            context: this.extractContext(content)
          });
          break; // Only add once per line
        }
      }
    }
    
    return changes;
  }

  /**
   * Detect API calls
   */
  private detectApiCalls(filePath: string, lineNumber: number, content: string): SemanticChange[] {
    const changes: SemanticChange[] = [];
    
    for (const pattern of SemanticAnalyzer.CALL_API_PATTERNS) {
      if (pattern.test(content)) {
        const description = this.describeApiCall(content);
        changes.push({
          category: 'call_api',
          filePath,
          lineNumber,
          lineContent: content,
          description,
          context: this.extractContext(content)
        });
        break; // Only add once per line
      }
    }
    
    return changes;
  }

  /**
   * Detect external reads (file I/O, database, config)
   */
  private detectExternalReads(filePath: string, lineNumber: number, content: string): SemanticChange[] {
    const changes: SemanticChange[] = [];
    
    for (const pattern of SemanticAnalyzer.READ_EXTERNAL_PATTERNS) {
      if (pattern.test(content)) {
        const description = this.describeExternalRead(content);
        changes.push({
          category: 'read_external',
          filePath,
          lineNumber,
          lineContent: content,
          description,
          context: this.extractContext(content)
        });
        break; // Only add once per line
      }
    }
    
    return changes;
  }

  /**
   * Detect exposed APIs
   */
  private detectExposedApis(filePath: string, lineNumber: number, content: string): SemanticChange[] {
    const changes: SemanticChange[] = [];
    
    for (const pattern of SemanticAnalyzer.EXPOSE_API_PATTERNS) {
      if (pattern.test(content)) {
        const description = this.describeExposedApi(content);
        changes.push({
          category: 'expose_api',
          filePath,
          lineNumber,
          lineContent: content,
          description,
          context: this.extractContext(content)
        });
        break; // Only add once per line
      }
    }
    
    return changes;
  }

  /**
   * Get line type from diff prefix
   */
  private getLineType(line: string): 'added' | 'deleted' | 'context' {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return 'added';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      return 'deleted';
    }
    return 'context';
  }

  /**
   * Check if there's a deletion near the current line (indicates modification)
   */
  private hasNearbyDeletion(lines: string[], currentIndex: number, range: number = 3): boolean {
    const start = Math.max(0, currentIndex - range);
    const end = Math.min(lines.length, currentIndex + range);
    
    for (let i = start; i < end; i++) {
      if (i !== currentIndex && lines[i].startsWith('-') && !lines[i].startsWith('---')) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check if there are additions near the current line (indicates modification, not pure deletion)
   */
  private hasNearbyAdditions(additions: Set<number>, currentIndex: number, range: number = 3): boolean {
    const start = Math.max(0, currentIndex - range);
    const end = currentIndex + range;
    
    for (let i = start; i <= end; i++) {
      if (additions.has(i)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Extract context from a line of code
   */
  private extractContext(content: string): string {
    const trimmed = content.trim();
    if (trimmed.length > 60) {
      return trimmed.substring(0, 57) + '...';
    }
    return trimmed;
  }

  /**
   * Extract function name from a line of code
   */
  private extractFunctionName(content: string): string | null {
    const trimmed = content.trim();
    
    // JavaScript/TypeScript function declarations
    let match = trimmed.match(/\bfunction\s+(\w+)\s*\(/);
    if (match) return match[1];
    
    // JavaScript/TypeScript arrow functions
    match = trimmed.match(/\b(const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/);
    if (match) return match[2];
    
    // JavaScript/TypeScript method definitions
    match = trimmed.match(/\b(\w+)\s*\([^)]*\)\s*\{/);
    if (match) return match[1];
    
    // Python/Ruby def
    match = trimmed.match(/\bdef\s+(\w+)/);
    if (match) return match[1];
    
    // Java/C#/C++ methods - Enhanced to support multiple modifiers and generic return types
    // Matches: [modifiers...] returnType methodName(
    match = trimmed.match(/\b(?:public|private|protected|internal|static|async|virtual|override|sealed|abstract|readonly|extern)(?:\s+(?:public|private|protected|internal|static|async|virtual|override|sealed|abstract|readonly|extern))*\s+(?:.+?)\s+(\w+)\s*\(/);
    if (match) return match[1];
    
    // Go functions
    match = trimmed.match(/\bfunc\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/);
    if (match) return match[1];
    
    // PHP functions
    match = trimmed.match(/\bfunction\s+(\w+)\s*\(/);
    if (match) return match[1];
    
    return null;
  }

  /**
   * Extract function name from diff hunk context (text after @@ markers)
   * Git includes function/method context in hunk headers for many languages
   */
  private extractFunctionNameFromContext(hunkContext: string): string {
    if (!hunkContext || hunkContext.trim().length === 0) return '';
    
    const trimmed = hunkContext.trim();
    
    // Skip control flow keywords
    const skipKeywords = ['if', 'for', 'while', 'switch', 'catch', 'try', 'else', 'return', 'throw', 'new'];
    
    // JavaScript/TypeScript: function name(...) or async function name(...)
    let match = trimmed.match(/\b(?:async\s+)?function\s+(\w+)/);
    if (match) return match[1];
    
    // JavaScript/TypeScript: const/let/var name = (...) => or = function
    match = trimmed.match(/\b(?:const|let|var)\s+(\w+)\s*=/);
    if (match && !skipKeywords.includes(match[1])) return match[1];
    
    // TypeScript/JavaScript class method: methodName(...) { or async methodName(...)
    match = trimmed.match(/^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/);
    if (match && !skipKeywords.includes(match[1])) return match[1];
    
    // TypeScript/JavaScript with modifiers: public/private methodName(...)
    match = trimmed.match(/\b(?:public|private|protected|static|async|readonly)\s+(?:async\s+)?(\w+)\s*\(/);
    if (match && !skipKeywords.includes(match[1])) return match[1];
    
    // Getter/setter: get/set propertyName()
    match = trimmed.match(/\b(?:get|set)\s+(\w+)\s*\(/);
    if (match) return match[1];
    
    // Python: def function_name(
    match = trimmed.match(/\bdef\s+(\w+)/);
    if (match) return match[1];
    
    // Go: func (receiver) functionName( or func functionName(
    match = trimmed.match(/\bfunc\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/);
    if (match) return match[1];
    
    // Java/C#/C++: access_modifier return_type methodName(
    // Enhanced to support multiple modifiers and generic return types
    match = trimmed.match(/\b(?:public|private|protected|internal|static|async|virtual|override|final|abstract|sealed|readonly|extern)(?:\s+(?:public|private|protected|internal|static|async|virtual|override|final|abstract|sealed|readonly|extern))*\s+(?:.+?)\s+(\w+)\s*\(/);
    if (match && !skipKeywords.includes(match[1])) return match[1];
    
    // Ruby: def method_name
    match = trimmed.match(/\bdef\s+(\w+)/);
    if (match) return match[1];
    
    // Fallback: look for word followed by ( that's not a keyword
    match = trimmed.match(/\b(\w+)\s*\(/);
    if (match && !skipKeywords.includes(match[1])) return match[1];
    
    // NOTE: Class/interface definitions are intentionally excluded
    // Code between methods inside a class should not be attributed to the class
    
    return '';
  }

  /**
   * Describe added logic
   */
  private describeAddedLogic(content: string): string {
    if (/\bif\s*\(/.test(content)) return 'Added conditional logic';
    if (/\bfor\s*\(/.test(content)) return 'Added loop';
    if (/\bwhile\s*\(/.test(content)) return 'Added while loop';
    if (/\bswitch\s*\(/.test(content)) return 'Added switch statement';
    if (/\btry\s*[{:]/.test(content)) return 'Added error handling';
    if (/\breturn\b/.test(content)) return 'Added return statement';
    return 'Added logic';
  }

  /**
   * Describe logic change
   */
  private describeLogicChange(content: string): string {
    if (/\bif\s*\(/.test(content)) return 'Modified conditional';
    if (/\bfor\s*\(/.test(content)) return 'Modified loop';
    if (/\bwhile\s*\(/.test(content)) return 'Modified while loop';
    if (/\breturn\b/.test(content)) return 'Modified return statement';
    if (/[&|!]=|[<>]=?|===?|!==?/.test(content)) return 'Modified comparison';
    return 'Modified logic';
  }

  /**
   * Describe API call
   */
  private describeApiCall(content: string): string {
    if (/\bfetch\s*\(/.test(content)) return 'HTTP fetch call';
    if (/\baxios\./.test(content)) return 'Axios HTTP call';
    if (/\.(get|post|put|patch|delete)\s*\(/.test(content)) return 'HTTP request';
    if (/\b(graphql|query|mutation)\s*\(/.test(content)) return 'GraphQL call';
    if (/\bnew\s+WebSocket/.test(content)) return 'WebSocket connection';
    if (/\b(ws|socket)\.(send|emit)/.test(content)) return 'WebSocket message';
    if (/\bgrpc\./.test(content)) return 'gRPC call';
    return 'API call';
  }

  /**
   * Describe external read
   */
  private describeExternalRead(content: string): string {
    if (/\b(readFile|readFileSync|open|File)\s*\(/.test(content)) return 'File read';
    if (/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(content)) return 'Database query';
    if (/\.(find|findOne|query)\s*\(/.test(content)) return 'Database read';
    if (/\bprocess\.env\./.test(content)) return 'Environment variable read';
    if (/\bconfig\./.test(content)) return 'Configuration read';
    return 'External data read';
  }

  /**
   * Describe exposed API
   */
  private describeExposedApi(content: string): string {
    if (/\.(get|Get)\s*\(/.test(content)) return 'GET endpoint';
    if (/\.(post|Post)\s*\(/.test(content)) return 'POST endpoint';
    if (/\.(put|Put)\s*\(/.test(content)) return 'PUT endpoint';
    if (/\.(patch|Patch)\s*\(/.test(content)) return 'PATCH endpoint';
    if (/\.(delete|Delete)\s*\(/.test(content)) return 'DELETE endpoint';
    if (/\bexport\s+(function|class)/.test(content)) return 'Exported API';
    if (/\bmodule\.exports/.test(content)) return 'Module export';
    return 'API exposed';
  }

  /**
   * Remove duplicate changes (same category, file, line, and content)
   */
  private deduplicateChanges(changes: SemanticChange[]): SemanticChange[] {
    const seen = new Set<string>();
    const unique: SemanticChange[] = [];
    
    for (const change of changes) {
      // Include content in the key to avoid duplicates with same location but different content
      const key = `${change.category}:${change.filePath}:${change.lineNumber}:${change.lineContent.trim()}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(change);
      }
    }
    
    return unique;
  }

  /**
   * Check if a line is empty or only contains a comment
   */
  private isEmptyOrComment(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return true;
    }
    
    // Check for comment patterns
    const commentPatterns = [
      /^\/\//,           // JavaScript, TypeScript, C#, C++, Java
      /^#/,              // Python, Ruby, Shell
      /^--/,             // SQL, Lua, Haskell
      /^'/,              // VB
      /^\/\*/,           // Multi-line comment start
      /^\*\//,           // Multi-line comment end
      /^<!--/,           // HTML comment
      /^-->/,            // HTML comment end
      /^\{-/,            // Haskell comment
      /^-\}/,            // Haskell comment end
    ];
    
    return commentPatterns.some(pattern => pattern.test(trimmed));
  }

  /**
   * Extract comment from a line of code
   */
  private extractComment(line: string): string | null {
    const trimmed = line.trim();
    
    // Single-line comments: //, ///, #, --
    const singleLinePatterns = [
      /^\/\/+\s*(.*)$/,         // JavaScript, TypeScript, C#, C++, Java (handles // and ///)
      /^#+\s*(.*)$/,            // Python, Ruby, Shell (handles # and ##)
      /^--+\s*(.*)$/,           // SQL, Lua, Haskell
      /^'\s*(.*)$/,             // VB
    ];
    
    for (const pattern of singleLinePatterns) {
      const match = trimmed.match(pattern);
      if (match) {
        // Remove any remaining leading / or # or - characters and trim
        let comment = match[1].replace(/^[\/\#\-]+\s*/, '').trim();
        if (comment.length > 0) {
          return comment;
        }
      }
    }
    
    // Multi-line comment start: /*, /**, <!--, {-
    if (trimmed.match(/^\/\*\*?\s*(.*)/) || 
        trimmed.match(/^<!--\s*(.*)/) ||
        trimmed.match(/^\{-\s*(.*)/)) {
      const commentMatch = trimmed.match(/^(?:\/\*\*?|<!--|\{-)\s*(.*?)(?:\*\/|-->|-\})?$/);
      if (commentMatch && commentMatch[1]) {
        // Remove any leading * characters (common in JSDoc style)
        let comment = commentMatch[1].replace(/^\*+\s*/, '').trim();
        if (comment.length > 0) {
          return comment;
        }
      }
    }
    
    return null;
  }
}

