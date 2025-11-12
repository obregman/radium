import Parser from 'tree-sitter';
import * as crypto from 'crypto';
import { MAX_FILE_SIZE } from '../utils/parser-constants';

export interface ParsedSymbol {
  kind: string;
  name: string;
  fqname: string;
  range: { start: number; end: number };
}

export interface ImportDeclaration {
  source: string;
  names: string[];
  range: { start: number; end: number };
}

export interface CallSite {
  callee: string;
  range: { start: number; end: number };
}

export interface ParseResult {
  symbols: ParsedSymbol[];
  imports: ImportDeclaration[];
  calls: CallSite[];
  hash: string;
}

/**
 * Abstract base class for language-specific parsers
 */
export abstract class BaseParser {
  protected parser: Parser;
  protected languageName: string;

  constructor(language: any, languageName: string) {
    this.parser = new Parser();
    this.parser.setLanguage(language);
    this.languageName = languageName;
  }

  /**
   * Parse a file and extract symbols, imports, and calls
   */
  async parse(filePath: string, code: string): Promise<ParseResult | null> {
    // Validate input early
    if (typeof code !== 'string') {
      console.error(`[Radium] Invalid code type for ${filePath}: ${typeof code}`);
      return { symbols: [], imports: [], calls: [], hash: '' };
    }

    if (code === null || code === undefined) {
      console.error(`[Radium] Code is null or undefined for ${filePath}`);
      return { symbols: [], imports: [], calls: [], hash: '' };
    }

    const hash = crypto.createHash('sha256').update(code).digest('hex');

    if (code.length === 0) {
      console.warn(`[Radium] Empty file: ${filePath}`);
      return { symbols: [], imports: [], calls: [], hash };
    }

    // Skip very large files
    if (code.length > MAX_FILE_SIZE) {
      console.warn(`[Radium] Skipping large file ${filePath} (${code.length} bytes, max: ${MAX_FILE_SIZE})`);
      return { symbols: [], imports: [], calls: [], hash };
    }

    // Check for null bytes or other invalid characters
    if (code.includes('\0')) {
      console.warn(`[Radium] File contains null bytes, skipping: ${filePath}`);
      return { symbols: [], imports: [], calls: [], hash };
    }

    console.log(`[Radium Parser] Parsing ${filePath} as ${this.languageName}, length: ${code.length}`);

    // Additional validation for tree-sitter
    if (typeof code !== 'string') {
      console.error(`[Radium] Code is not a string, type: ${typeof code}`);
      return { symbols: [], imports: [], calls: [], hash };
    }

    // Log file characteristics for debugging
    const lineCount = code.split('\n').length;
    const hasCRLF = code.includes('\r\n');
    const hasLF = code.includes('\n');
    console.log(`[Radium Parser] File stats: ${lineCount} lines, CRLF: ${hasCRLF}, LF: ${hasLF}`);

    // Check for BOM (Byte Order Mark) which can cause issues
    let hadBOM = false;
    if (code.charCodeAt(0) === 0xFEFF) {
      console.warn(`[Radium] Removing BOM from ${filePath}`);
      code = code.substring(1);
      hadBOM = true;
    }

    // Check for unusual characters that might cause issues
    const hasHighUnicode = /[\u0080-\uFFFF]/.test(code.substring(0, 1000));
    if (hasHighUnicode) {
      console.log(`[Radium Parser] File contains Unicode characters (might be comments or strings)`);
    }

    let tree;
    const language = this.parser.getLanguage();
    
    try {
      console.log(`[Radium Parser] Attempting parse with ${this.languageName} parser...`);
      tree = this.parser.parse(code);
      console.log(`[Radium Parser] Parse succeeded on first attempt`);
    } catch (parseError) {
      console.error(`[Radium] Tree-sitter parse failed for ${filePath}`);
      console.error(`[Radium] Parse error:`, parseError);
      console.error(`[Radium] Code type: ${typeof code}, length: ${code.length}`);
      console.error(`[Radium] First 100 chars: ${code.substring(0, 100)}`);
      console.error(`[Radium] Last 100 chars: ${code.substring(code.length - 100)}`);
      console.error(`[Radium] Has null bytes: ${code.includes('\0')}`);
      console.error(`[Radium] Had BOM: ${hadBOM}`);
      console.error(`[Radium] Line endings: CRLF=${hasCRLF}, LF=${hasLF}`);
      
      // Try one more time with a fresh parser instance
      // Sometimes tree-sitter gets into a bad state
      try {
        console.warn(`[Radium] Retrying parse with fresh parser instance`);
        const freshParser = new Parser();
        console.log(`[Radium] Fresh parser language set: ${language ? 'yes' : 'no'}`);
        freshParser.setLanguage(language);
        tree = freshParser.parse(code);
        console.log(`[Radium] ✓ Retry succeeded for ${filePath}`);
      } catch (retryError) {
        console.error(`[Radium] Retry also failed:`, retryError);
        console.error(`[Radium] Error name: ${(retryError as Error).name}`);
        console.error(`[Radium] Error message: ${(retryError as Error).message}`);
        console.error(`[Radium] Error stack: ${(retryError as Error).stack}`);
        
        // Last resort: try parsing just the first 50KB to see if it's a size issue
        if (code.length > 50000) {
          try {
            console.warn(`[Radium] Attempting to parse first 50KB only as diagnostic...`);
            const truncated = code.substring(0, 50000);
            const testParser = new Parser();
            testParser.setLanguage(language);
            const testTree = testParser.parse(truncated);
            console.log(`[Radium] Truncated parse succeeded - file size might be the issue`);
          } catch (truncError) {
            console.error(`[Radium] Even truncated parse failed - likely a parser/language issue`);
          }
        }
        
        // Fallback will be handled by the caller
        return null;
      }
    }

    if (!tree || !tree.rootNode) {
      console.warn(`[Radium] Invalid parse tree for ${filePath}`);
      return { symbols: [], imports: [], calls: [], hash };
    }

    // Check if the tree has syntax errors
    const hasErrors = this.treeHasErrors(tree.rootNode);
    if (hasErrors) {
      console.warn(`[Radium] Parse tree has syntax errors for ${filePath}, attempting extraction anyway`);
    }

    const symbols: ParsedSymbol[] = [];
    const imports: ImportDeclaration[] = [];
    const calls: CallSite[] = [];

    try {
      this.extractSymbols(tree.rootNode, code, symbols, imports, calls, filePath);
    } catch (extractError) {
      console.warn(`[Radium] Symbol extraction failed for ${filePath}:`, extractError);
      // Return partial results if any were extracted before the error
    }

    console.log(`[Radium Parser] Extracted ${symbols.length} symbols, ${imports.length} imports, ${calls.length} calls from ${filePath}`);

    return { symbols, imports, calls, hash };
  }

  /**
   * Check if the syntax tree has errors
   */
  protected treeHasErrors(node: Parser.SyntaxNode): boolean {
    if (node.type === 'ERROR' || node.isMissing) {
      return true;
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && this.treeHasErrors(child)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract symbols, imports, and calls from the syntax tree
   * Must be implemented by language-specific parsers
   */
  protected abstract extractSymbols(
    node: Parser.SyntaxNode,
    code: string,
    symbols: ParsedSymbol[],
    imports: ImportDeclaration[],
    calls: CallSite[],
    filePath: string,
    namespace?: string
  ): void;
}

