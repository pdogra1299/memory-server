# Knowledge Graph Memory Server

[![npm version](https://img.shields.io/npm/v/mcp-memory-server.svg)](https://www.npmjs.com/package/mcp-memory-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A basic implementation of persistent memory using a local knowledge graph. This lets Claude remember information about the user across chats.

## Installation

### NPM (Recommended)

```bash
npm install -g mcp-memory-server
```

Or use directly with npx:

```bash
npx mcp-memory-server
```

### From Source

```bash
git clone https://github.com/pdogra1299/memory-server.git
cd memory-server
npm install
npm run build
```

## Core Concepts

### Entities
Entities are the primary nodes in the knowledge graph. Each entity has:
- A unique name (identifier)
- An entity type (e.g., "person", "organization", "event", "component", "service")
- A list of observations
- Temporal tracking (createdAt, updatedAt timestamps)
- Previous observations (preserved when entity is updated)
- Metadata (confidence level, access count, source file)

Example:
```json
{
  "name": "John_Smith",
  "entityType": "person",
  "observations": ["Speaks fluent Spanish"],
  "createdAt": "2025-01-03T10:30:00.000Z",
  "updatedAt": "2025-01-03T10:30:00.000Z",
  "previousObservations": null,
  "metadata": {
    "confidence": "high",
    "accessCount": 0
  }
}
```

### Anti-Hallucination Support
For component entities, use the `@props` convention in observations to define valid properties:
```json
{
  "name": "Button",
  "entityType": "component",
  "observations": [
    "Primary UI button component",
    "@props variant: 'primary' | 'secondary' | 'danger'",
    "@props onClick: () => void",
    "@props disabled?: boolean"
  ]
}
```

### Relations
Relations define directed connections between entities. They are always stored in active voice and describe how entities interact or relate to each other.

Example:
```json
{
  "from": "John_Smith",
  "to": "Anthropic",
  "relationType": "works_at"
}
```
### Observations
Observations are discrete pieces of information about an entity. They are:

- Stored as strings
- Attached to specific entities
- Can be added or removed independently
- Should be atomic (one fact per observation)

Example:
```json
{
  "entityName": "John_Smith",
  "observations": [
    "Speaks fluent Spanish",
    "Graduated in 2019",
    "Prefers morning meetings"
  ]
}
```

## API

### Tools
- **create_entities**
  - Create multiple new entities in the knowledge graph
  - Input: `entities` (array of objects)
    - Each object must contain ALL fields:
      - `name` (string): Entity identifier
      - `entityType` (string): Type classification
      - `observations` (string[]): Associated observations
      - `createdAt` (string): ISO date when created
      - `updatedAt` (string): ISO date when last updated
      - `previousObservations` (array or null): Previous state
      - `metadata` (object): Contains confidence, accessCount, sourceFile
  - Ignores entities with existing names

- **create_relations**
  - Create multiple new relations between entities
  - Input: `relations` (array of objects)
    - Each object contains:
      - `from` (string): Source entity name
      - `to` (string): Target entity name
      - `relationType` (string): Relationship type in active voice
  - Returns structured result:
    - `created`: Successfully created relations
    - `skipped`: Duplicate relations that were skipped
    - `errors`: Relations with invalid entities
  - Validates that both entities exist before creating

- **add_observations**
  - Add new observations to existing entities
  - Input: `observations` (array of objects)
    - Each object contains:
      - `entityName` (string): Target entity
      - `contents` (string[]): New observations to add
  - Returns structured result:
    - `success`: Array of successful additions with added/skipped counts
    - `errors`: Array of errors for non-existent entities
  - Updates entity timestamp when observations are added
  - Skips duplicate observations automatically

- **delete_entities**
  - Remove entities and their relations
  - Input: `entityNames` (string[])
  - Cascading deletion of associated relations
  - Silent operation if entity doesn't exist

- **delete_observations**
  - Remove specific observations from entities
  - Input: `deletions` (array of objects)
    - Each object contains:
      - `entityName` (string): Target entity
      - `observations` (string[]): Observations to remove
  - Silent operation if observation doesn't exist

- **delete_relations**
  - Remove specific relations from the graph
  - Input: `relations` (array of objects)
    - Each object contains:
      - `from` (string): Source entity name
      - `to` (string): Target entity name
      - `relationType` (string): Relationship type
  - Silent operation if relation doesn't exist

- **read_graph**
  - Read the entire knowledge graph
  - No input required
  - Returns complete graph structure with all entities and relations

- **search_nodes**
  - Search for nodes based on query
  - Input: `query` (string)
  - Searches across:
    - Entity names
    - Entity types
    - Observation content
  - Returns matching entities and their relations
  - Increments access count for all found entities

- **open_nodes**
  - Retrieve specific nodes by name
  - Input: `names` (string[])
  - Returns:
    - Requested entities
    - Relations between requested entities
  - Silently skips non-existent nodes
  - Increments access count for tracking

- **get_stale_entities**
  - Find entities that haven't been updated recently
  - Input: 
    - `days` (number): Number of days to consider an entity stale
    - `entityType` (string, optional): Filter by entity type
  - Returns array of stale entities with:
    - Entity details
    - Days since last update
    - Refresh recommendations based on usage

- **validate_component_props**
  - Validate component props to prevent hallucination
  - Input:
    - `componentName` (string): Name of the component
    - `propsToCheck` (string[]): Array of prop names to validate
  - Returns:
    - `valid` (boolean): Whether all props are valid
    - `invalidProps` (string[]): Props that don't exist
    - `validProps` (string[]): Props that do exist
    - `allAvailableProps` (string[]): All props defined with @props
    - `staleness`: Days since last update with optional warning
  - Increments access count

- **update_entity**
  - Update an existing entity while preserving history
  - Input:
    - `name` (string): Entity name
    - `observations` (string[], optional): New observations
    - `metadata` (object, optional): Metadata updates
  - Preserves previous observations when updating
  - Updates timestamps automatically
  - Returns updated entity or null if not found

- **get_frequently_used**
  - Find entities accessed frequently
  - Input:
    - `minAccessCount` (number): Minimum access threshold
    - `entityType` (string, optional): Filter by type
  - Returns entities sorted by access count
  - Useful for identifying high-priority refresh targets

# Usage with Claude Desktop

### Setup

Add this to your claude_desktop_config.json:

#### NPX (Recommended - uses published NPM package)
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-memory-server"
      ]
    }
  }
}
```

#### NPX with custom setting

The server can be configured using the following environment variables:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-memory-server"
      ],
      "env": {
        "MEMORY_FILE_PATH": "/path/to/custom/memory.json"
      }
    }
  }
}
```

- `MEMORY_FILE_PATH`: Path to the memory storage JSON file (default: `memory.json` in the server directory)

#### Docker

```json
{
  "mcpServers": {
    "memory": {
      "command": "docker",
      "args": ["run", "-i", "-v", "claude-memory:/app/dist", "--rm", "mcp/memory"]
    }
  }
}
```

# VS Code Installation Instructions

For quick installation, use one of the one-click installation buttons below:

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-NPM-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=memory&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mcp-memory-server%22%5D%7D) [![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-NPM-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=memory&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mcp-memory-server%22%5D%7D&quality=insiders)

[![Install with Docker in VS Code](https://img.shields.io/badge/VS_Code-Docker-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=memory&config=%7B%22command%22%3A%22docker%22%2C%22args%22%3A%5B%22run%22%2C%22-i%22%2C%22-v%22%2C%22claude-memory%3A%2Fapp%2Fdist%22%2C%22--rm%22%2C%22mcp%2Fmemory%22%5D%7D) [![Install with Docker in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Docker-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=memory&config=%7B%22command%22%3A%22docker%22%2C%22args%22%3A%5B%22run%22%2C%22-i%22%2C%22-v%22%2C%22claude-memory%3A%2Fapp%2Fdist%22%2C%22--rm%22%2C%22mcp%2Fmemory%22%5D%7D&quality=insiders)

For manual installation, add the following JSON block to your User Settings (JSON) file in VS Code. You can do this by pressing `Ctrl + Shift + P` and typing `Preferences: Open Settings (JSON)`.

Optionally, you can add it to a file called `.vscode/mcp.json` in your workspace. This will allow you to share the configuration with others. 

> Note that the `mcp` key is not needed in the `.vscode/mcp.json` file.

#### NPX

```json
{
  "mcp": {
    "servers": {
      "memory": {
        "command": "npx",
        "args": [
          "-y",
          "mcp-memory-server"
        ]
      }
    }
  }
}
```

#### Docker

```json
{
  "mcp": {
    "servers": {
      "memory": {
        "command": "docker",
        "args": [
          "run",
          "-i",
          "-v",
          "claude-memory:/app/dist",
          "--rm",
          "mcp/memory"
        ]
      }
    }
  }
}
```

## Key Features

### Temporal Tracking
- All entities track creation and update timestamps (ISO date strings)
- Previous observations are preserved when entities are updated
- Staleness detection helps identify outdated information

### Anti-Hallucination Support
- Component entities can define valid props using `@props` convention
- `validate_component_props` tool prevents using non-existent properties
- Staleness warnings when component info is outdated

### Smart Refresh
- Access count tracking identifies frequently used entities
- Prioritize updates for high-use, stale entities
- Automatic access count increments on search/open/validate

### Structured Error Handling
- All modification tools return structured success/error responses
- LLM-friendly error messages guide corrective actions
- Validation prevents invalid operations (e.g., relations to non-existent entities)

### System Prompt

The prompt for utilizing memory depends on the use case. Changing the prompt will help the model determine the frequency and types of memories created.

Here is an example prompt for chat personalization. You could use this prompt in the "Custom Instructions" field of a [Claude.ai Project](https://www.anthropic.com/news/projects). 

```
Follow these steps for each interaction:

1. User Identification:
   - You should assume that you are interacting with default_user
   - If you have not identified default_user, proactively try to do so.

2. Memory Retrieval:
   - Always begin your chat by saying only "Remembering..." and retrieve all relevant information from your knowledge graph
   - Always refer to your knowledge graph as your "memory"

3. Memory
   - While conversing with the user, be attentive to any new information that falls into these categories:
     a) Basic Identity (age, gender, location, job title, education level, etc.)
     b) Behaviors (interests, habits, etc.)
     c) Preferences (communication style, preferred language, etc.)
     d) Goals (goals, targets, aspirations, etc.)
     e) Relationships (personal and professional relationships up to 3 degrees of separation)

4. Memory Update:
   - If any new information was gathered during the interaction, update your memory as follows:
     a) Create entities for recurring organizations, people, and significant events
     b) Connect them to the current entities using relations
     b) Store facts about them as observations
```

## Building

### From Source

```bash
npm install
npm run build
```

### Docker

```bash
docker build -t mcp/memory -f src/memory/Dockerfile . 
```

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.

## Links

- [NPM Package](https://www.npmjs.com/package/mcp-memory-server)
- [GitHub Repository](https://github.com/pdogra1299/memory-server)
- [Model Context Protocol](https://modelcontextprotocol.io)
