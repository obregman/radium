import { BaseParser } from './base-parser';
import { TypeScriptParser } from './typescript-parser';
import { PythonParser } from './python-parser';
import { CSharpParser } from './csharp-parser';
import { GoParser } from './go-parser';
import { LANGUAGE_NAMES } from '../utils/parser-constants';

/**
 * Factory for creating and managing language-specific parsers
 * Uses singleton pattern to reuse parser instances
 */
export class ParserFactory {
  private static parsers: Map<string, BaseParser> = new Map();

  /**
   * Get a parser for the specified language
   * Creates the parser on first use and caches it
   */
  static getParser(language: string): BaseParser | null {
    // Return cached parser if available
    if (this.parsers.has(language)) {
      return this.parsers.get(language)!;
    }

    // Create new parser based on language
    let parser: BaseParser | null = null;

    try {
      switch (language) {
        case LANGUAGE_NAMES.TSX:
          // TSX needs its own parser for proper JSX support
          parser = new TypeScriptParser('tsx');
          break;

        case LANGUAGE_NAMES.TYPESCRIPT:
        case LANGUAGE_NAMES.JAVASCRIPT:
          // TypeScript and JavaScript can share a parser
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

      // Cache the parser
      this.parsers.set(language, parser);
      return parser;
    } catch (error) {
      console.error(`[Radium] Failed to initialize parser for ${language}:`, error);
      return null;
    }
  }

  /**
   * Clear all cached parsers (useful for testing)
   */
  static clearCache(): void {
    this.parsers.clear();
  }
}

