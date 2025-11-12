import { ParsedSymbol } from '../parsers/base-parser';

/**
 * Fallback regex-based symbol extraction for when tree-sitter fails
 * This is a simple pattern-matching approach that works for basic TypeScript/JavaScript
 */
export function extractSymbolsWithRegex(code: string, filePath: string): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  
  // Extract functions: function name(...) or async function name(...)
  const functionRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
  let match;
  while ((match = functionRegex.exec(code)) !== null) {
    const name = match[1];
    const startIndex = match.index;
    symbols.push({
      kind: 'function',
      name,
      fqname: name,
      range: { start: startIndex, end: startIndex + match[0].length }
    });
  }
  
  // Extract classes: class ClassName
  const classRegex = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
  while ((match = classRegex.exec(code)) !== null) {
    const name = match[1];
    const startIndex = match.index;
    symbols.push({
      kind: 'class',
      name,
      fqname: name,
      range: { start: startIndex, end: startIndex + match[0].length }
    });
  }
  
  // Extract interfaces: interface InterfaceName
  const interfaceRegex = /(?:export\s+)?interface\s+(\w+)/g;
  while ((match = interfaceRegex.exec(code)) !== null) {
    const name = match[1];
    const startIndex = match.index;
    symbols.push({
      kind: 'interface',
      name,
      fqname: name,
      range: { start: startIndex, end: startIndex + match[0].length }
    });
  }
  
  // Extract type aliases: type TypeName =
  const typeRegex = /(?:export\s+)?type\s+(\w+)\s*=/g;
  while ((match = typeRegex.exec(code)) !== null) {
    const name = match[1];
    const startIndex = match.index;
    symbols.push({
      kind: 'type',
      name,
      fqname: name,
      range: { start: startIndex, end: startIndex + match[0].length }
    });
  }
  
  // Extract const: const NAME =
  const constRegex = /(?:export\s+)?const\s+(\w+)\s*=/g;
  while ((match = constRegex.exec(code)) !== null) {
    const name = match[1];
    const startIndex = match.index;
    symbols.push({
      kind: 'constant',
      name,
      fqname: name,
      range: { start: startIndex, end: startIndex + match[0].length }
    });
  }
  
  console.log(`[Radium] Regex extraction found: ${symbols.length} symbols from ${filePath}`);
  return symbols;
}

