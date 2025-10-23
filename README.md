# Radium

A VS Code extension that visualizes your codebase as an interactive graph and tracks changes made by LLMs.

## What It Does

Radium indexes your codebase and creates a visual map showing files, their relationships, and how they're organized into components. When working with LLMs, it tracks all changes made to your code, allowing you to review, apply, or rollback them.

## Features

- Interactive graph visualization of your codebase
- Component-based architecture view (defined in `radium-components.yaml`)
- Track and manage LLM-generated changes
- Impact analysis for code modifications
- Support for TypeScript, JavaScript, and Python
- Session history and rollback capability

## Usage

### Basic Setup

1. Install the extension
2. Open your project in VS Code
3. Run command: `Radium: Open Map`

The extension indexes your workspace and displays an interactive graph.

### Defining Components

Create a `radium-components.yaml` file in your project root:

```yaml
spec:
  components:
    - frontend:
        name: Frontend
        description: UI components
        files:
          - src/components/**
          - src/views/**
        external:
    
    - backend:
        name: Backend
        description: API and business logic
        files:
          - src/api/**
          - src/services/**
        external:
          - type: PostgreSQL
            name: MainDB
            description: Primary database
          - type: Redis
            name: Cache
            description: Session cache
```

Components appear as color-coded boxes in the graph. Files are grouped by their component. External objects (databases, APIs, services) are shown as white rounded rectangles connected to their components.

### Visualizing Features

Create a `radium-features.yaml` file to visualize your product features and their relationships:

```yaml
spec:
  features:
  - authentication:
      name: User Authentication
      description: Login and registration system
      status: completed
      owner: Backend Team
      components:
        - backend
        - frontend
      dependencies: []
  
  - user-profile:
      name: User Profile
      description: User profile management
      status: in-progress
      owner: Frontend Team
      components:
        - frontend
      dependencies:
        - authentication
      flow:
        - type: user
          name: Click edit profile
          description: User clicks the edit profile button
        - type: window
          name: Show profile form
          description: Display editable profile form
        - type: user
          name: Update details
          description: User modifies their information
        - type: api
          name: Save profile
          description: Send updated data to backend
        - type: database
          name: Update database
          description: Store changes in database
        - type: window
          name: Show success
          description: Display confirmation message
```

Run `Radium: Features Map` to see an interactive visualization of your features, their status, dependencies, and user flows. Flow items are displayed as colored boxes connected by arrows, showing the sequence of steps in each feature.

### Dev Mode: Managing Requirements

Radium dev mode allows you to add, track, and validate requirements for each feature.

#### Setting Up Requirements

Create a `radium-req.yaml` file in your project root:

```yaml
spec:
  requirements:
    - authentication:
        - id: req-auth-1
          text: "User can log in with email and password"
          status: implemented
          implementedStatus: true
        - id: req-auth-2
          text: "Password reset via email"
          status: in-progress
          implementedStatus: false
```

#### Using Dev Mode

1. Open Dev Mode: `Radium: Dev Mode` (or `Radium: Features Map`)
2. Click the three-dot menu (⋮) on any feature box
3. Select **"+ Add requirement"** to add a new requirement
4. Click on any requirement to:
   - **Edit** - Modify the requirement text
   - **Validate** - Use AI to check if it's implemented
   - **Delete** - Remove the requirement

#### Requirement Status

Requirements show two indicators:
- **Left gauge** (colored circle): Status (not-started, in-progress, implemented, verified)
  - Gray: not-started
  - Orange: in-progress
  - Green: implemented
  - Blue: verified
- **Right gauge**: Implementation status (gray = not implemented, green = implemented)

#### AI Validation

Click **"Validate requirements"** from the feature menu to automatically check all requirements using AI. The AI analyzes your codebase and updates the implementation status for each requirement.

**Supported AI Providers:**
- **Cursor AI** - Recommended for Cursor users (set `radium.devMode.aiProvider` to `"cursor"`)
- **GitHub Copilot** - For VS Code with Copilot subscription
- **Claude API** - Coming soon

The validator automatically provides code context from relevant component files to improve accuracy.

📖 **See [Cursor Integration Guide](docs/cursor-integration.md) for detailed setup and usage**

### Working with LLM Changes

1. Get a change plan from your LLM in JSON format:

```json
{
  "intent": "add authentication",
  "rationale": "Adding user login flow",
  "edits": [
    {
      "path": "src/auth.ts",
      "operations": [
        {
          "type": "replace",
          "range": { "start": [10, 0], "end": [20, 0] },
          "text": "export function authenticate(token: string) {\n  return verifyToken(token);\n}"
        }
      ]
    }
  ],
  "tests": ["tests/auth.spec.ts"],
  "risk": "medium"
}
```

2. Copy the JSON to clipboard
3. Run: `Radium: Preview LLM Plan from Clipboard`
4. Review the changes in the graph
5. Run: `Radium: Apply LLM Plan` to apply, or reject them

### Available Commands

- `Radium: Open Map` - Show the codebase graph
- `Radium: Features Map` - Visualize features and their relationships
- `Radium: Dev Mode` - Open Features Map with requirement management
- `Radium: Select AI Provider` - Choose AI provider (Cursor, Copilot, Claude)
- `Radium: Show Changes` - View recent sessions
- `Radium: Preview LLM Plan from Clipboard` - Preview changes
- `Radium: Apply LLM Plan` - Apply previewed changes
- `Radium: Undo Last LLM Session` - Rollback a session
- `Radium: Find Impact` - Analyze impact of selected code
- `Radium: Export Session Patch` - Export session as patch file

## Configuration

Available settings:

```json
{
  "radium.indexer.maxCPU": 2,
  "radium.privacy.upload": "none",
  "radium.graph.layout": "force",
  "radium.tests.autoRun": true,
  "radium.devMode.enabled": true,
  "radium.devMode.aiProvider": "copilot",
  "radium.devMode.showDetailedStatus": false
}
```

## Installation

### From GitHub Releases

Download the `.vsix` file from the [Releases page](https://github.com/obregman/radium/releases).

Install via VS Code:
1. Extensions view → `...` menu → "Install from VSIX..."
2. Select the downloaded file

Or via command line:
```bash
code --install-extension radium-0.1.0.vsix
```

**Having installation issues?** See [TEST-INSTALLATION.md](TEST-INSTALLATION.md) for detailed debugging steps.

### Building from Source

**Requirements:** Node.js 20 or later

```bash
npm install
npm run compile
npm run package
```

This creates a `.vsix` file you can install.

## Automatic Releases

Every push to `main` automatically:
1. Increments the minor version (e.g., 0.1.0 → 0.1.1)
2. Commits the version bump back to the repository
3. Builds the extension
4. Creates a `.vsix` package
5. Publishes a GitHub Release with the build

The release is tagged with the new version and the commit SHA.

## Documentation

- [Architecture](docs/architecture.md)
- [Usage Guide](docs/usage-guide.md)
- [Dev Mode (Requirements Management)](docs/dev-mode.md)
- [radium-components.yaml Format](docs/radium-yaml.md)
- [radium-features.yaml Format](docs/radium-features.md)
- [Troubleshooting](docs/troubleshooting.md)

## Prompt

Add this instruction to your project to trigger the generation of the necessary yaml files:

```markdown

The VSCode add-on Radium requires the following files to be available in the project root folder:
1. radium-components.yaml - describes a logical visualization of the codebase.
2. radium-features.yaml - describes the different feature flows
3. radium-req.yaml - describes the feature requirements

Review the project code and generate the files in the project root.

1. radium-components.yaml syntax:

spec:
  components:
    - views:
        name: Views
        description: UI components and visualization panels
        files:
          - src/views/view-manager.ts
        external:
          
    - store:
        name: Data Store
        description: Database schema and storage adapter
        files:
          - src/store/db-schema.ts
        external:
          - type: PostgreSQL
            name: MainDB
            description: Stores the user data

Guidelines:
- Keep the description detailed but under 200 words
- External sources include: Cloud services (RDS, S3, SQS, etc.), Data files, external API or service, etc.

2. radium-features.yaml syntax

spec:
  features:
      - new_customer:
        name: Add a new customer to the system
        flow:
        - type: user
          name: The user clicks on add new user
          description: The user clicks on add new customer
        - type: window
          name: App displays the "new customer" screen
          description: Shows the "new customer" screen to the user
        - type: user
          name: The user fills the new customer's details
          description: The user fills customer name, address, phone number and email


3. radium-req.yaml syntax:

spec:
  requirements:
    - feature-key:
        name: "Feature Display Name"
        description: "Brief description of what this feature does"
        requirements:
          - id: req-unique-id
            text: "Specific, measurable requirement description"
            status: not-started | in-progress | implemented | verified

Guidelines:
- Each feature block must have a name and description field
- The feature name should be clear and user-facing
- The description should briefly explain the feature's purpose
- Write clear, specific, and measurable requirements
- Use action-oriented language (e.g., "User can...", "System validates...")
- Keep each requirement atomic (one testable thing)
- Set status based on implementation progress:
  * not-started: No implementation yet (gray gauge)
  * in-progress: Partially implemented (orange gauge)
  * implemented: Fully implemented (green gauge)
  * verified: Implemented and tested (blue gauge)
- Features in radium-req.yaml are independent from radium-features.yaml
- Generate requirements based on the feature's purpose and user needs
          
```

## License

MIT
