# create-atlas-plugin

Scaffold a new Atlas plugin project.

## Usage

```bash
bun create atlas-plugin my-plugin
```

### Options

```
--type <type>       Plugin type (datasource, context, interaction, action, sandbox) [default: datasource]
--scope <scope>     Package scope (e.g. @useatlas) [default: @useatlas]
--defaults, -y      Use all default values (non-interactive)
--help, -h          Show this help message
```

### Examples

```bash
# Interactive setup
bun create atlas-plugin my-datasource

# Quick scaffold with defaults
bun create atlas-plugin my-plugin --defaults

# Specific plugin type
bun create atlas-plugin my-context --type context

# Custom scope
bun create atlas-plugin my-plugin --scope @myorg --type action
```

## Generated Files

```
my-plugin/
├── src/
│   ├── index.ts         # Plugin entry point with typed skeleton
│   └── index.test.ts    # Tests using SDK testing utilities
├── package.json         # npm-ready with correct peer deps
├── tsconfig.json        # Self-contained TypeScript config
├── README.md            # Template with install/configure/usage
├── LICENSE              # Apache-2.0
└── .gitignore
```

## Plugin Types

| Type | Description |
|------|-------------|
| `datasource` | Connect a new database or data source |
| `context` | Inject additional context into the agent prompt |
| `interaction` | Add HTTP routes for external integrations |
| `action` | Add approval-gated write operations |
| `sandbox` | Custom explore backend for code isolation |

## License

Apache-2.0
