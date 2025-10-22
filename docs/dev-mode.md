# Radium Dev Mode

Dev mode adds interactive requirement management to Radium's Features Map, enabling you to track, validate, and manage feature requirements directly in the visualization.

## Overview

Dev mode allows you to:
- Add requirements to features through a visual interface
- Edit and delete requirements with context menus
- Validate requirements using AI to check implementation status
- Track requirement progress with visual gauges
- Store requirements in `radium-req.yaml` for version control

## Getting Started

### 1. Enable Dev Mode

Dev mode is enabled by default. To configure it:

```json
{
  "radium.devMode.enabled": true,
  "radium.devMode.aiProvider": "copilot",
  "radium.devMode.showDetailedStatus": false
}
```

### 2. Create Requirements File

Create a `radium-req.yaml` file in your workspace root:

```yaml
spec:
  requirements:
    - authentication:
        - id: req-auth-1
          text: "User can log in with email and password"
          status: implemented
          implementedStatus: true
        - id: req-auth-2
          text: "Session persists across browser restarts"
          status: in-progress
          implementedStatus: false
```

### 3. Open Dev Mode

Run the command: `Radium: Dev Mode`

This opens the Features Map with a helpful tip about using the three-dot menu to manage requirements.

Alternatively, you can use `Radium: Features Map` which provides the same functionality.

## Using Dev Mode

### Adding Requirements

1. Click the three-dot menu (⋮) in the top-right corner of any feature box
2. Select **"+ Add requirement"**
3. Enter the requirement text in the input dialog
4. The requirement appears immediately in the feature box

### Editing Requirements

1. Click on any requirement text
2. Select **"Edit"** from the context menu
3. Modify the text in the input dialog
4. Changes are saved automatically to `radium-req.yaml`

### Deleting Requirements

1. Click on any requirement text
2. Select **"Delete"** from the context menu
3. Confirm the deletion
4. The requirement is removed from the file

### Validating Requirements

#### Single Requirement

1. Click on a requirement
2. Select **"Validate"** from the context menu
3. AI analyzes the codebase and updates the status
4. View the validation result with confidence score

#### All Feature Requirements

1. Click the three-dot menu on a feature
2. Select **"Validate requirements"**
3. AI validates all requirements for that feature
4. Progress notification shows validation status

## Understanding Requirement Indicators

Each requirement displays two gauges:

### Status Gauge (Left Circle)

Indicates the development status of the requirement:

- **Gray (○)**: `not-started` - No work has begun
- **Orange (●)**: `in-progress` - Partially implemented
- **Green (●)**: `implemented` - Fully implemented
- **Blue (●)**: `verified` - Implemented and tested

### Implementation Gauge (Right Circle)

Binary indicator of implementation:

- **Gray (○)**: Not implemented (`implementedStatus: false`)
- **Green (●)**: Implemented (`implementedStatus: true`)

## AI Validation

### How It Works

The AI validator:
1. Analyzes the feature's associated components
2. Examines code in those components
3. Determines if the requirement is implemented
4. Provides a confidence score (0-100%)
5. Explains the reasoning

### Validation Prompt

The AI receives context including:
- Feature name and description
- Associated components
- Requirement text
- Codebase structure

### Validation Response

The AI returns:
```json
{
  "status": "implemented",
  "confidence": 85,
  "reasoning": "Found login form component with email/password validation"
}
```

### AI Providers

Radium supports multiple AI providers for requirement validation:

#### Cursor AI (Recommended for Cursor users)
- Uses Cursor's built-in language model API
- Automatically detects and uses available Cursor models
- Provides code context from component files
- Set provider to `"cursor"` in settings

#### GitHub Copilot
- Uses VS Code's Copilot integration
- Requires active Copilot subscription
- Set provider to `"copilot"` in settings

#### Claude API
- Direct Claude API integration (coming soon)
- Requires API key configuration
- Set provider to `"claude"` in settings

Configure the provider in VS Code settings:
```json
{
  "radium.devMode.aiProvider": "cursor"
}
```

Or via Settings UI:
1. Open Settings (Cmd/Ctrl + ,)
2. Search for "radium ai provider"
3. Select your preferred provider from dropdown

**Fallback Behavior:**
- If the selected provider is unavailable, Radium will try other available models
- If no AI models are available, you'll be prompted to paste a manual response

## File Format

### radium-req.yaml Structure

```yaml
spec:
  requirements:
    - feature-key-1:
        - id: req-unique-id
          text: "Requirement description"
          status: not-started | in-progress | implemented | verified
          implementedStatus: true | false
    - feature-key-2:
        - id: req-another-id
          text: "Another requirement"
          status: implemented
          implementedStatus: true
```

### Field Descriptions

- **id**: Unique identifier (auto-generated if not provided)
- **text**: Human-readable requirement description
- **status**: Development status (not-started, in-progress, implemented, verified)
- **implementedStatus**: Boolean indicating if requirement is implemented

## Visual Layout

Feature boxes in the Features Map display requirements below the feature title:

```
┌─────────────────────────────────────────┐
│ User Authentication                  ⋮  │ ← Three-dot menu
│                                          │
│ ● Login with email/password        [●]  │ ← Requirement with gauges
│ ● Session persistence              [○]  │
│ ○ Two-factor authentication        [○]  │
│                                          │
│ [Flow items appear below...]            │
└─────────────────────────────────────────┘
```

## Best Practices

### Writing Requirements

- Be specific and measurable
- Focus on user-facing functionality
- Keep requirements atomic (one thing per requirement)
- Use action verbs ("User can...", "System validates...")

**Good:**
```yaml
- text: "User can reset password via email link"
```

**Bad:**
```yaml
- text: "Password stuff works"
```

### Organizing Requirements

- Group related requirements under the same feature
- Use status to track progress
- Validate regularly during development
- Update implementedStatus when completing work

### Version Control

- Commit `radium-req.yaml` to your repository
- Review requirement changes in pull requests
- Use requirements as acceptance criteria
- Link requirements to issues/tickets

## Workflow Example

### 1. Planning Phase

```yaml
spec:
  requirements:
    - user-profile:
        - id: req-profile-1
          text: "User can view their profile"
          status: not-started
          implementedStatus: false
        - id: req-profile-2
          text: "User can edit profile information"
          status: not-started
          implementedStatus: false
```

### 2. Development Phase

Update status as you work:

```yaml
- id: req-profile-1
  text: "User can view their profile"
  status: implemented
  implementedStatus: true
- id: req-profile-2
  text: "User can edit profile information"
  status: in-progress
  implementedStatus: false
```

### 3. Validation Phase

Run AI validation to verify implementation:
1. Click "Validate requirements" on the feature
2. AI checks each requirement
3. Review validation results
4. Update status to `verified` for confirmed requirements

### 4. Review Phase

Use requirements in code reviews:
- Verify all requirements are addressed
- Check implementation matches requirement text
- Ensure tests cover requirements
- Update status to `verified` after review

## Troubleshooting

### Requirements Not Showing

1. Check `radium-req.yaml` exists in workspace root
2. Verify YAML syntax is valid
3. Ensure feature keys match `radium-features.yaml`
4. Reload Features Map: close and reopen

### Validation Fails

1. Check AI provider is configured correctly
2. Verify internet connection (for cloud providers)
3. Check VS Code language model API is available
4. Try manual validation by reviewing code

### File Not Saving

1. Check file permissions on `radium-req.yaml`
2. Verify workspace is writable
3. Check VS Code output for errors
4. Try manually editing the file to test

## Advanced Usage

### Custom Status Labels

While the default statuses work for most cases, you can interpret them differently:

- `not-started` → Backlog
- `in-progress` → Sprint
- `implemented` → Done
- `verified` → Released

### Integration with Issue Trackers

Link requirements to issues by including issue IDs in the text:

```yaml
- text: "User can export data to CSV (#123)"
  status: in-progress
```

### Requirement Templates

Create templates for common requirement types:

**User Story Template:**
```
As a [user type], I want to [action] so that [benefit]
```

**Acceptance Criteria Template:**
```
Given [context], when [action], then [outcome]
```

## Configuration Reference

### radium.devMode.enabled

- **Type**: boolean
- **Default**: true
- **Description**: Enable or disable dev mode features

### radium.devMode.aiProvider

- **Type**: string
- **Options**: "copilot", "cursor", "claude"
- **Default**: "copilot"
- **Description**: AI provider for requirement validation

### radium.devMode.showDetailedStatus

- **Type**: boolean
- **Default**: false
- **Description**: Show detailed status labels instead of just colored gauges

## Related Documentation

- [radium-features.yaml Format](./radium-features.md)
- [Architecture Documentation](./architecture.md)
- [Usage Guide](./usage-guide.md)
- [README](../README.md)

## Examples

See `radium-req.yaml.example` in the project root for a complete example.

