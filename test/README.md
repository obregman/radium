# Radium Tests

This directory contains unit and integration tests for the Radium extension.

## Structure

```
test/
├── index.ts              # Test runner entry point
├── runTest.ts            # VS Code test launcher
├── indexer/
│   └── parser.test.ts    # Parser unit tests
└── README.md             # This file
```

## Running Tests

### From Command Line

```bash
npm test
```

### From VS Code

1. Open the Run and Debug view (Cmd+Shift+D)
2. Select "Extension Tests" from the dropdown
3. Press F5 to run

## Writing Tests

Tests use the Mocha test framework with VS Code's test runner. Use the `suite` and `test` functions:

```typescript
import * as assert from 'assert';

suite('My Test Suite', () => {
  test('should do something', () => {
    assert.strictEqual(1 + 1, 2);
  });
});
```

## Test Coverage

### Parser Tests (`indexer/parser.test.ts`)

- TypeScript parsing (classes, functions, interfaces, types)
- C# parsing (classes, interfaces)
- Python parsing (classes, functions)
- Language detection
- Error handling

## Adding New Tests

1. Create a new `.test.ts` file in the appropriate subdirectory
2. Import `assert` and the code you want to test
3. Write your test suites and test cases
4. Run `npm test` to verify

## Debugging Tests

1. Set breakpoints in your test file or source code
2. Run tests in debug mode (F5 in VS Code)
3. Use the Debug Console to inspect variables

