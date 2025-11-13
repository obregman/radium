import { ParsedSymbol } from '../parsers/base-parser';

/**
 * Fallback regex-based symbol extraction for when tree-sitter fails
 * Supports TypeScript, JavaScript, C#, Python, and Go
 */
export function extractSymbolsWithRegex(code: string, filePath: string): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const ext = filePath.toLowerCase().split('.').pop();
  let match;
  
  // Detect language from file extension
  const isCSharp = ext === 'cs' || filePath.toLowerCase().endsWith('.xaml.cs');
  const isPython = ext === 'py';
  const isGo = ext === 'go';
  const isTypeScript = ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx';
  
  if (isCSharp) {
    console.log(`[Radium Regex] Extracting C# symbols from ${filePath}`);
    
    // C# Methods: public/private/protected/internal void/async/Task MethodName(...)
    const methodRegex = /(?:public|private|protected|internal|static|\s)+(?:async\s+)?(?:void|Task|int|string|bool|double|float|long|decimal|object|[\w<>]+)\s+(\w+)\s*\([^)]*\)\s*(?:{|=>)/g;
    while ((match = methodRegex.exec(code)) !== null) {
      const name = match[1];
      // Filter out common keywords that might match
      if (!['get', 'set', 'if', 'for', 'while', 'switch', 'return', 'new'].includes(name.toLowerCase())) {
        const startIndex = match.index;
        // Find the end of the method by counting braces
        let endIndex = findMethodEnd(code, startIndex);
        symbols.push({
          kind: 'method',
          name,
          fqname: name,
          range: { start: startIndex, end: endIndex }
        });
      }
    }
    
    // C# Classes: public/private/internal class ClassName
    const classRegex = /(?:public|private|internal|protected|sealed|abstract|\s)+class\s+(\w+)/g;
    while ((match = classRegex.exec(code)) !== null) {
      const name = match[1];
      const startIndex = match.index;
      let endIndex = findBlockEnd(code, startIndex);
      symbols.push({
        kind: 'class',
        name,
        fqname: name,
        range: { start: startIndex, end: endIndex }
      });
    }
    
    // C# Interfaces
    const interfaceRegex = /(?:public|private|internal|\s)+interface\s+(\w+)/g;
    while ((match = interfaceRegex.exec(code)) !== null) {
      const name = match[1];
      const startIndex = match.index;
      let endIndex = findBlockEnd(code, startIndex);
      symbols.push({
        kind: 'interface',
        name,
        fqname: name,
        range: { start: startIndex, end: endIndex }
      });
    }
    
    // C# Properties: public Type PropertyName { get; set; }
    const propertyRegex = /(?:public|private|protected|internal|\s)+(?:static\s+)?[\w<>]+\s+(\w+)\s*{\s*get/g;
    while ((match = propertyRegex.exec(code)) !== null) {
      const name = match[1];
      const startIndex = match.index;
      symbols.push({
        kind: 'property',
        name,
        fqname: name,
        range: { start: startIndex, end: startIndex + match[0].length + 20 }
      });
    }
  } else if (isTypeScript) {
    // TypeScript/JavaScript functions
    const functionRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
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
    
    // Classes
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
    
    // Interfaces
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
  } else if (isPython) {
    // Python functions: def function_name(
    const functionRegex = /def\s+(\w+)\s*\(/g;
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
    
    // Python classes: class ClassName:
    const classRegex = /class\s+(\w+)/g;
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
  } else if (isGo) {
    // Go functions: func FunctionName(
    const functionRegex = /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/g;
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
    
    // Go types: type TypeName struct
    const typeRegex = /type\s+(\w+)\s+(?:struct|interface)/g;
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
  }
  
  console.log(`[Radium Regex] Extracted ${symbols.length} symbols from ${filePath}`);
  if (symbols.length > 0) {
    console.log(`[Radium Regex] Symbol names: ${symbols.map(s => s.name).join(', ')}`);
  }
  return symbols;
}

/**
 * Find the end of a C# method by counting braces
 */
function findMethodEnd(code: string, startIndex: number): number {
  let braceCount = 0;
  let inMethod = false;
  
  for (let i = startIndex; i < code.length; i++) {
    const char = code[i];
    
    if (char === '{') {
      braceCount++;
      inMethod = true;
    } else if (char === '}') {
      braceCount--;
      if (inMethod && braceCount === 0) {
        return i + 1;
      }
    }
  }
  
  return Math.min(startIndex + 500, code.length); // Default to 500 chars if not found
}

/**
 * Find the end of a C# class/interface block
 */
function findBlockEnd(code: string, startIndex: number): number {
  let braceCount = 0;
  let foundStart = false;
  
  for (let i = startIndex; i < code.length; i++) {
    const char = code[i];
    
    if (char === '{') {
      braceCount++;
      foundStart = true;
    } else if (char === '}') {
      braceCount--;
      if (foundStart && braceCount === 0) {
        return i + 1;
      }
    }
  }
  
  return Math.min(startIndex + 1000, code.length); // Default to 1000 chars if not found
}

