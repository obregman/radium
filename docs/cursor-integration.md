# Cursor AI Integration Guide

Radium integrates with Cursor AI to provide intelligent requirement validation using Cursor's built-in language models.

## Setup

### 1. Configure AI Provider

Set Cursor as your AI provider using one of these methods:

**Via Command Palette:**
1. Open Command Palette (Cmd/Ctrl + Shift + P)
2. Run: `Radium: Select AI Provider`
3. Choose "Cursor AI"

**Via Settings:**
1. Open Settings (Cmd/Ctrl + ,)
2. Search for "radium ai provider"
3. Select "cursor" from dropdown

**Via settings.json:**
```json
{
  "radium.devMode.aiProvider": "cursor"
}
```

### 2. Verify Cursor Models

Radium will automatically detect available Cursor language models. No additional configuration is needed if you have Cursor installed and activated.

## Using Validation

### Validate Single Requirement

1. Open Dev Mode: `Radium: Dev Mode`
2. Click on any requirement
3. Select **"Validate"** from context menu
4. Cursor AI analyzes the codebase
5. View results with confidence score and reasoning

### Validate All Requirements

1. Click the three-dot menu (⋮) on a feature
2. Select **"Validate requirements"**
3. Cursor AI validates all requirements sequentially
4. Progress notification shows status

## How It Works

### Context Gathering

When validating a requirement, Radium provides Cursor with:
- Feature name and description
- Associated component file paths
- **Actual file contents** (up to 5 files, 5000 characters each)
- Requirement text to validate

This rich context allows Cursor to make accurate assessments.

### Validation Flow

```
User triggers validation
    ↓
Radium gathers component context
    ↓
Builds validation prompt with file contents
    ↓
Sends to Cursor AI via Language Model API
    ↓
Cursor analyzes code and requirement
    ↓
Returns JSON response with status, confidence, reasoning
    ↓
Radium updates requirement status in radium-req.yaml
    ↓
UI refreshes with new status gauges
```

### Response Format

Cursor returns a structured response:

```json
{
  "status": "implemented",
  "confidence": 85,
  "reasoning": "Found complete implementation in auth.ts with login form, password validation, and session management"
}
```

**Status values:**
- `implemented` - Fully working and complete
- `in-progress` - Partially implemented
- `not-started` - No implementation found

**Confidence:** 0-100% certainty level

**Reasoning:** Brief explanation of the assessment

## Troubleshooting

### Cursor Models Not Available

If Cursor models aren't detected:

1. **Check Cursor Installation:** Ensure Cursor is properly installed
2. **Restart Extension:** Reload VS Code window
3. **Check Logs:** View Output → Radium for detailed logs
4. **Try Fallback:** Radium will automatically try other available models

### Validation Fails

If validation fails:

1. **Check Component Paths:** Ensure `radium-features.yaml` has correct file paths
2. **Verify File Exists:** Component files must exist in workspace
3. **Review Logs:** Check Output → Radium for error details
4. **Manual Fallback:** Radium will prompt for manual input if AI unavailable

### Rate Limiting

Radium includes a 500ms delay between validations to avoid rate limiting. When validating multiple requirements, this is automatic.

## Best Practices

### 1. Define Components

In `radium-features.yaml`, specify relevant component files:

```yaml
spec:
  features:
    - user-authentication:
        name: User Authentication
        description: Login and session management
        components:
          - src/auth/login.ts
          - src/auth/session.ts
          - src/middleware/auth-middleware.ts
```

### 2. Write Clear Requirements

In `radium-req.yaml`, write specific, measurable requirements:

```yaml
spec:
  requirements:
    - user-authentication:
        name: User Authentication
        description: Secure user login system
        requirements:
          - id: req-auth-001
            text: "User can log in with email and password"
            status: not-started
          - id: req-auth-002
            text: "System validates password strength (min 8 chars, 1 number, 1 special)"
            status: not-started
```

### 3. Validate Incrementally

- Validate requirements as you implement them
- Use validation to track progress
- Review confidence scores - low confidence may indicate unclear requirements

### 4. Leverage Context

- Keep component files focused and well-organized
- Cursor analyzes actual code, so clear code = better validation
- Include relevant test files in components for better accuracy

## Advanced Configuration

### Custom Context Size

Currently, Radium includes up to 5 files with 5000 characters each. This is hardcoded for optimal performance but may be configurable in future versions.

### Provider Fallback Chain

If Cursor is unavailable, Radium tries:
1. Cursor models (vendor: 'cursor')
2. Any available language model
3. Manual input prompt

This ensures validation always works, even without Cursor.

## Examples

### Example 1: Authentication Feature

```yaml
# radium-features.yaml
spec:
  features:
    - auth:
        name: Authentication
        components:
          - src/auth.ts
          - src/login-form.tsx

# radium-req.yaml
spec:
  requirements:
    - auth:
        name: Authentication
        description: User login system
        requirements:
          - id: req-1
            text: "User can log in with email/password"
            status: not-started
```

**Validation Result:**
```
Status: implemented
Confidence: 90%
Reasoning: Found LoginForm component with email/password inputs, authentication service with login method, and session management
```

### Example 2: API Integration

```yaml
# radium-features.yaml
spec:
  features:
    - payment-api:
        name: Payment API Integration
        components:
          - src/api/payment.ts
          - src/services/stripe.ts

# radium-req.yaml
spec:
  requirements:
    - payment-api:
        name: Payment API
        description: Stripe payment processing
        requirements:
          - id: req-pay-1
            text: "System processes credit card payments via Stripe"
            status: not-started
```

**Validation Result:**
```
Status: in-progress
Confidence: 65%
Reasoning: Found Stripe SDK integration and payment service, but missing error handling and webhook verification
```

## Comparison with Other Providers

| Feature | Cursor AI | Copilot | Claude API |
|---------|-----------|---------|------------|
| Setup | Automatic | Requires subscription | Requires API key |
| Context | File contents | File contents | File contents |
| Availability | Cursor users | VS Code + Copilot | API key holders |
| Cost | Included with Cursor | Separate subscription | Pay per use |
| Accuracy | High | High | High |

## Support

For issues or questions:
1. Check Output → Radium for detailed logs
2. Review this guide
3. File an issue on GitHub with logs

## Future Enhancements

Planned improvements:
- Configurable context size
- Multi-file analysis for complex requirements
- Validation history and trends
- Automatic re-validation on code changes
- Custom validation prompts per feature

