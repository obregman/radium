import { BaseParser } from './base-parser';
import { TypeScriptParser } from './typescript-parser';
import { PythonParser } from './python-parser';
import { CSharpParser } from './csharp-parser';
import { GoParser } from './go-parser';
import { LANGUAGE_NAMES } from '../utils/parser-constants';

/**
 * Factory for creating language-specific parsers
 * Creates fresh parser instances to avoid state corruption issues
 */
export class ParserFactory {
  /**
   * Get a fresh parser for the specified language
   * Creates a new parser instance each time to avoid tree-sitter state issues
   */
  static getParser(language: string): BaseParser | null {
    // Create new parser based on language
    // We don't cache parsers because tree-sitter can get into bad states
    // after parsing errors, causing subsequent parses to fail
    let parser: BaseParser | null = null;

    try {
      switch (language) {
        case LANGUAGE_NAMES.TSX:
          // TSX needs its own parser for proper JSX support
          parser = new TypeScriptParser('tsx');
          break;

        case LANGUAGE_NAMES.TYPESCRIPT:
        case LANGUAGE_NAMES.JAVASCRIPT:
          // TypeScript and JavaScript parsers
          parser = new TypeScriptParser(language);
          break;

        case LANGUAGE_NAMES.PYTHON:
          parser = new PythonParser();
          break;

        case LANGUAGE_NAMES.CSHARP:
          parser = new CSharpParser();
          break;

        case LANGUAGE_NAMES.GO:
          parser = new GoParser();
          break;

        default:
          console.warn(`[Radium] No parser available for language: ${language}`);
          return null;
      }

      return parser;
    } catch (error) {
      console.error(`[Radium] Failed to initialize parser for ${language}:`, error);
      return null;
    }
  }

  /**
   * Clear all cached parsers (useful for testing)
   * No-op since we no longer cache parsers
   */
  static clearCache(): void {
    // No-op: parsers are no longer cached
  }
}

