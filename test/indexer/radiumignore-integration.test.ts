import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { RadiumIgnore } from '../../src/config/radium-ignore';

suite('RadiumIgnore Integration Tests', () => {
  let tempDir: string;
  let radiumDir: string;
  let radiumIgnorePath: string;

  setup(() => {
    // Create temporary directory structure
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radium-test-'));
    radiumDir = path.join(tempDir, '.radium');
    radiumIgnorePath = path.join(radiumDir, 'radiumignore');
    
    fs.mkdirSync(radiumDir, { recursive: true });
  });

  teardown(() => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('should ignore files matching extension patterns', () => {
    // Create radiumignore with extension pattern
    fs.writeFileSync(radiumIgnorePath, '*.g.cs\n*.generated.ts\n');
    
    const radiumIgnore = new RadiumIgnore(tempDir);
    
    assert.strictEqual(radiumIgnore.shouldIgnore('src/Model.g.cs'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('src/types.generated.ts'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('src/Model.cs'), false);
    assert.strictEqual(radiumIgnore.shouldIgnore('src/types.ts'), false);
  });

  test('should ignore files in directory patterns', () => {
    // Create radiumignore with directory patterns
    fs.writeFileSync(radiumIgnorePath, 'debug/\nbuild/\ntemp/\n');
    
    const radiumIgnore = new RadiumIgnore(tempDir);
    
    assert.strictEqual(radiumIgnore.shouldIgnore('debug/test.ts'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('build/output.js'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('temp/cache.json'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('src/main.ts'), false);
  });

  test('should ignore files matching glob patterns', () => {
    // Create radiumignore with glob patterns
    fs.writeFileSync(radiumIgnorePath, '**/*.test.ts\n**/*.spec.ts\n');
    
    const radiumIgnore = new RadiumIgnore(tempDir);
    
    assert.strictEqual(radiumIgnore.shouldIgnore('src/utils.test.ts'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('test/parser.spec.ts'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('src/utils.ts'), false);
  });

  test('should ignore specific files', () => {
    // Create radiumignore with specific file patterns
    fs.writeFileSync(radiumIgnorePath, 'config.local.json\n.env.local\n');
    
    const radiumIgnore = new RadiumIgnore(tempDir);
    
    assert.strictEqual(radiumIgnore.shouldIgnore('config.local.json'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('.env.local'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('config.json'), false);
    assert.strictEqual(radiumIgnore.shouldIgnore('.env'), false);
  });

  test('should handle comments and empty lines', () => {
    // Create radiumignore with comments and empty lines
    fs.writeFileSync(radiumIgnorePath, 
      '# This is a comment\n' +
      '*.g.cs\n' +
      '\n' +
      '# Another comment\n' +
      'debug/\n'
    );
    
    const radiumIgnore = new RadiumIgnore(tempDir);
    
    assert.strictEqual(radiumIgnore.shouldIgnore('Model.g.cs'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('debug/test.ts'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('# This is a comment'), false);
  });

  test('should handle nested directory patterns', () => {
    // Create radiumignore with nested directory pattern
    fs.writeFileSync(radiumIgnorePath, 'src/generated/\n');
    
    const radiumIgnore = new RadiumIgnore(tempDir);
    
    assert.strictEqual(radiumIgnore.shouldIgnore('src/generated/models.ts'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('src/generated/types/user.ts'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('src/models.ts'), false);
  });

  test('should handle Windows-style paths', () => {
    // Create radiumignore with directory pattern
    fs.writeFileSync(radiumIgnorePath, 'debug/\n*.g.cs\n');
    
    const radiumIgnore = new RadiumIgnore(tempDir);
    
    // Test with Windows-style backslashes (should be normalized internally)
    assert.strictEqual(radiumIgnore.shouldIgnore('debug\\test.ts'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('src\\Model.g.cs'), true);
  });

  test('should return false when no radiumignore file exists', () => {
    // Don't create radiumignore file
    const radiumIgnore = new RadiumIgnore(tempDir);
    
    assert.strictEqual(radiumIgnore.shouldIgnore('any/file.ts'), false);
    assert.strictEqual(radiumIgnore.shouldIgnore('debug/test.ts'), false);
  });

  test('should reload patterns when reload() is called', () => {
    // Create initial radiumignore
    fs.writeFileSync(radiumIgnorePath, '*.test.ts\n');
    
    const radiumIgnore = new RadiumIgnore(tempDir);
    assert.strictEqual(radiumIgnore.shouldIgnore('file.test.ts'), true);
    assert.strictEqual(radiumIgnore.shouldIgnore('file.spec.ts'), false);
    
    // Update radiumignore file
    fs.writeFileSync(radiumIgnorePath, '*.spec.ts\n');
    
    // Before reload, old patterns still apply
    assert.strictEqual(radiumIgnore.shouldIgnore('file.test.ts'), true);
    
    // After reload, new patterns apply
    radiumIgnore.reload();
    assert.strictEqual(radiumIgnore.shouldIgnore('file.test.ts'), false);
    assert.strictEqual(radiumIgnore.shouldIgnore('file.spec.ts'), true);
  });

  test('should get all loaded patterns', () => {
    fs.writeFileSync(radiumIgnorePath, '*.test.ts\ndebug/\nconfig.json\n');
    
    const radiumIgnore = new RadiumIgnore(tempDir);
    const patterns = radiumIgnore.getPatterns();
    
    assert.strictEqual(patterns.length, 3);
    assert.strictEqual(patterns.includes('*.test.ts'), true);
    assert.strictEqual(patterns.includes('debug/'), true);
    assert.strictEqual(patterns.includes('config.json'), true);
  });

  test('should report if patterns are loaded', () => {
    const radiumIgnore1 = new RadiumIgnore(tempDir);
    assert.strictEqual(radiumIgnore1.hasPatterns(), false);
    
    fs.writeFileSync(radiumIgnorePath, '*.test.ts\n');
    const radiumIgnore2 = new RadiumIgnore(tempDir);
    assert.strictEqual(radiumIgnore2.hasPatterns(), true);
  });

  test('should ignore directories with shouldIgnoreDirectory', () => {
    fs.writeFileSync(radiumIgnorePath, 'debug/\nbuild/\nsrc/generated/\n');
    
    const radiumIgnore = new RadiumIgnore(tempDir);
    
    // Should ignore exact directory matches
    assert.strictEqual(radiumIgnore.shouldIgnoreDirectory('debug'), true);
    assert.strictEqual(radiumIgnore.shouldIgnoreDirectory('build'), true);
    
    // Should ignore nested directories
    assert.strictEqual(radiumIgnore.shouldIgnoreDirectory('src/generated'), true);
    
    // Should ignore subdirectories of ignored directories
    assert.strictEqual(radiumIgnore.shouldIgnoreDirectory('debug/subdir'), true);
    assert.strictEqual(radiumIgnore.shouldIgnoreDirectory('src/generated/models'), true);
    
    // Should not ignore unrelated directories
    assert.strictEqual(radiumIgnore.shouldIgnoreDirectory('src'), false);
    assert.strictEqual(radiumIgnore.shouldIgnoreDirectory('test'), false);
  });

  test('shouldIgnoreDirectory should handle glob patterns', () => {
    fs.writeFileSync(radiumIgnorePath, '**/*.test.ts\n**/node_modules/**\n');
    
    const radiumIgnore = new RadiumIgnore(tempDir);
    
    // Glob patterns for directories
    assert.strictEqual(radiumIgnore.shouldIgnoreDirectory('node_modules'), true);
    assert.strictEqual(radiumIgnore.shouldIgnoreDirectory('src/node_modules'), true);
    
    // Regular directories should not be affected by file glob patterns
    assert.strictEqual(radiumIgnore.shouldIgnoreDirectory('src'), false);
    assert.strictEqual(radiumIgnore.shouldIgnoreDirectory('test'), false);
  });
});

