# Testing Cursor Validation

Quick guide to test the Cursor AI validation implementation.

## Prerequisites

- Radium extension installed
- Cursor IDE (or VS Code with Cursor extension)
- `radium-req.yaml` file in workspace

## Test Steps

### 1. Configure Cursor Provider

**Option A: Via Command Palette**
```
Cmd/Ctrl + Shift + P → "Radium: Select AI Provider" → Choose "Cursor AI"
```

**Option B: Via Settings**
```json
{
  "radium.devMode.aiProvider": "cursor"
}
```

### 2. Open Dev Mode

```
Cmd/Ctrl + Shift + P → "Radium: Dev Mode"
```

### 3. Test Single Requirement Validation

1. Click on any requirement in the Dev Mode panel
2. Select **"Validate"** from the context menu
3. Watch for progress notification
4. Check the Output panel (View → Output → Radium) for logs

**Expected Logs:**
```
[AI Validator] Using provider: cursor
[AI Validator] Using Cursor model: <model-name>
[AI Validator] Cursor response received
```

**Expected Result:**
- Requirement status updates (gray → orange/green)
- Notification shows confidence score and reasoning
- Status gauge changes color

### 4. Test Batch Validation

1. Click the three-dot menu (⋮) on a feature
2. Select **"Validate requirements"**
3. Watch progress notification for each requirement

**Expected:**
- All requirements validated sequentially
- 500ms delay between validations
- All statuses update in UI

### 5. Test Fallback Behavior

**Test A: No Cursor Models**

If Cursor models aren't available:
1. Run validation
2. Check logs for fallback message
3. Verify it tries other available models

**Expected Logs:**
```
[AI Validator] Using provider: cursor
[AI Validator] No Cursor models available, trying fallback
[AI Validator] Using fallback model: <vendor>/<model>
```

**Test B: No Models Available**

If no AI models are available:
1. Run validation
2. Should show manual input dialog
3. Can paste response or cancel

### 6. Test Context Gathering

**Setup:**
Create a feature with components in `radium-features.yaml`:

```yaml
spec:
  features:
    - test-feature:
        name: Test Feature
        components:
          - src/validation/ai-validator.ts
          - src/extension.ts
```

**Test:**
1. Validate a requirement for this feature
2. Check Output logs
3. Should see file contents included in prompt

**Expected:**
- Logs show component files being read
- Validation prompt includes file contents
- Max 5 files, 5000 chars each

### 7. Test Provider Switching

1. Set provider to "cursor"
2. Validate a requirement
3. Run `Radium: Select AI Provider`
4. Switch to "copilot"
5. Validate another requirement
6. Check logs to verify provider changed

**Expected:**
```
[AI Validator] Using provider: cursor
... (after switch)
[AI Validator] Using provider: copilot
```

## Verification Checklist

- [ ] Provider selection command appears in palette
- [ ] Can switch between Cursor, Copilot, Claude
- [ ] Configuration persists after reload
- [ ] Single requirement validation works
- [ ] Batch validation works with delays
- [ ] Status updates correctly in UI
- [ ] Confidence scores display
- [ ] Reasoning text shows in notification
- [ ] Logs show correct provider being used
- [ ] Fallback works when provider unavailable
- [ ] Manual input prompt appears when no AI
- [ ] Component context included in prompts
- [ ] File truncation works (5000 char limit)
- [ ] Error handling works for missing files

## Common Issues

### Issue: "No Cursor models available"

**Cause:** Cursor language model API not accessible

**Solutions:**
1. Verify Cursor is installed and activated
2. Check if running in Cursor IDE vs VS Code
3. Try reloading window
4. Check fallback works to other models

### Issue: Validation returns "not-started" with 0% confidence

**Cause:** AI call failed

**Solutions:**
1. Check Output logs for error details
2. Verify network connectivity
3. Try manual input fallback
4. Switch to different provider

### Issue: Context not including files

**Cause:** Component paths incorrect or files don't exist

**Solutions:**
1. Verify paths in `radium-features.yaml`
2. Check files exist in workspace
3. Use relative paths from workspace root
4. Check Output logs for file read errors

## Success Criteria

✅ **Functional:**
- All validation methods work
- Provider switching works
- Fallback chain functions
- UI updates correctly

✅ **Performance:**
- Validation completes in reasonable time
- No rate limiting errors
- Delays between batch validations work

✅ **Reliability:**
- Graceful error handling
- Fallback to manual input works
- No crashes or hangs

✅ **User Experience:**
- Clear notifications
- Helpful error messages
- Intuitive provider selection
- Good logging for debugging

## Test Data

Use the example `radium-req.yaml.example` file for testing:

```bash
cp radium-req.yaml.example radium-req.yaml
```

This provides realistic requirements to validate.

## Debugging

### Enable Verbose Logging

Check Output panel: View → Output → Select "Radium"

### Key Log Messages

```
[AI Validator] Using provider: <provider>
[AI Validator] Using <provider> model: <model-name>
[AI Validator] <Provider> response received
[AI Validator] Could not read component file: <path>
[AI Validator] Validation failed: <error>
```

### Check Configuration

```typescript
// In VS Code console (Cmd/Ctrl + Shift + I)
vscode.workspace.getConfiguration('radium.devMode').get('aiProvider')
```

## Reporting Issues

If validation doesn't work:

1. Collect logs from Output → Radium
2. Note which provider was selected
3. Include error messages
4. Describe expected vs actual behavior
5. Include `radium-req.yaml` and `radium-features.yaml` (if relevant)

## Next Steps

After successful testing:

1. Test with real project requirements
2. Validate accuracy of AI assessments
3. Tune component definitions for better context
4. Provide feedback on validation quality

