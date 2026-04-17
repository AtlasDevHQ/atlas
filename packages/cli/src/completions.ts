/**
 * Shell completion scripts for the Atlas CLI.
 *
 * Generates completion scripts for bash, zsh, and fish that complete
 * commands and their flags.
 *
 * Usage:
 *   atlas completions bash   # Output bash completion script
 *   atlas completions zsh    # Output zsh completion script
 *   atlas completions fish   # Output fish completion script
 *
 * Installation:
 *   # bash — add to ~/.bashrc:
 *   eval "$(atlas completions bash)"
 *
 *   # zsh — add to ~/.zshrc:
 *   eval "$(atlas completions zsh)"
 *
 *   # fish — run once:
 *   atlas completions fish > ~/.config/fish/completions/atlas.fish
 */

type Shell = "bash" | "zsh" | "fish";

interface CommandSpec {
  description: string;
  flags: Record<string, string>;
}

/** All CLI commands and their flags. Keep in sync with command handlers in bin/atlas.ts. */
export const COMMANDS: Record<string, CommandSpec> = {
  init: {
    description: "Profile DB and generate semantic layer",
    flags: {
      "--tables": "Only specific tables/views (comma-separated)",
      "--schema": "PostgreSQL schema (default: public)",
      "--source": "Write to semantic/{name}/ subdirectory",
      "--connection": "Profile a datasource from atlas.config.ts",
      "--csv": "Load CSV files via DuckDB",
      "--parquet": "Load Parquet files via DuckDB",
      "--enrich": "Profile + LLM enrichment",
      "--no-enrich": "Skip LLM enrichment",
      "--demo": "Load demo dataset (simple, cybersec, ecommerce)",
      "--force": "Continue even if more than 20% of tables fail to profile",
    },
  },
  diff: {
    description: "Compare DB schema against semantic layer",
    flags: {
      "--tables": "Only diff specific tables/views (comma-separated)",
      "--schema": "PostgreSQL schema (default: public)",
      "--source": "Read from semantic/{name}/ subdirectory",
    },
  },
  query: {
    description: "Ask a question via the Atlas API",
    flags: {
      "--json": "Raw JSON output",
      "--csv": "CSV output (pipe-friendly)",
      "--quiet": "Data only, no narrative",
      "--auto-approve": "Auto-approve pending actions",
      "--connection": "Query a specific datasource",
    },
  },
  doctor: {
    description: "Validate environment and connectivity",
    flags: {},
  },
  validate: {
    description: "Check config and semantic layer YAML files",
    flags: {},
  },
  mcp: {
    description: "Start MCP server",
    flags: {
      "--transport": "Transport type (stdio or sse)",
      "--port": "Port for SSE transport",
    },
  },
  learn: {
    description: "Analyze audit log and propose YAML improvements",
    flags: {
      "--apply": "Write proposed changes to YAML files",
      "--limit": "Max audit log entries to analyze",
      "--since": "Only analyze queries after this date",
      "--source": "Read from/write to semantic/{name}/ subdirectory",
      "--suggestions": "Generate query suggestions from audit log",
      "--auto-approve": "With --suggestions: skip admin moderation queue",
    },
  },
  improve: {
    description: "Analyze semantic layer and propose data-driven improvements",
    flags: {
      "-i": "Start interactive conversation mode",
      "--interactive": "Start interactive conversation mode",
      "--apply": "Write proposed changes to YAML files",
      "--min-confidence": "Minimum confidence to include (0-1, default: 0.5)",
      "--entities": "Limit to specific entities (comma-separated)",
      "--since": "Only analyze audit log entries after this date",
      "--source": "Read from/write to semantic/{name}/ subdirectory",
      "--schema": "PostgreSQL schema (default: public)",
    },
  },
  migrate: {
    description: "Semantic layer versioning (snapshot, diff, rollback)",
    flags: {
      "-m": "Message for the snapshot",
      "--message": "Message for the snapshot",
      "--force": "Create snapshot even if nothing changed",
      "--from": "Source snapshot hash for diff",
      "--to": "Target snapshot hash for diff",
      "--source": "Use semantic/{name}/ subdirectory",
      "--limit": "Max entries to show in log",
    },
  },
  plugin: {
    description: "Manage plugins (list, create, add)",
    flags: {
      "--type": "Plugin type for create (datasource, context, interaction, action)",
    },
  },
  eval: {
    description: "Run eval pipeline against demo schemas",
    flags: {
      "--schema": "Filter by demo dataset name",
      "--category": "Filter by category",
      "--difficulty": "Filter by difficulty (simple|medium|complex)",
      "--id": "Run a single case",
      "--limit": "Max cases to evaluate",
      "--resume": "Resume from existing JSONL results file",
      "--baseline": "Save results as new baseline",
      "--compare": "Diff against baseline (exit 1 on regression)",
      "--csv": "CSV output",
      "--json": "JSON summary output",
    },
  },
  smoke: {
    description: "Run E2E smoke tests",
    flags: {
      "--target": "API base URL",
      "--api-key": "Bearer auth token",
      "--timeout": "Per-check timeout in ms",
      "--verbose": "Show full response bodies on failure",
      "--json": "Machine-readable JSON output",
    },
  },
  benchmark: {
    description: "Run BIRD benchmark for text-to-SQL accuracy",
    flags: {
      "--bird-path": "Path to the downloaded BIRD dev directory",
      "--limit": "Max questions to evaluate",
      "--db": "Filter to a single database",
      "--csv": "CSV output",
      "--resume": "Resume from existing JSONL results file",
    },
  },
  export: {
    description: "Export workspace data to a migration bundle",
    flags: {
      "--output": "Output file path (default: ./atlas-export-{date}.json)",
      "-o": "Alias for --output",
      "--org": "Export data for a specific org",
    },
  },
  "migrate-import": {
    description: "Import an export bundle into a hosted Atlas instance",
    flags: {
      "--bundle": "Path to the export bundle JSON file (required)",
      "--target": "Target Atlas API URL (default: https://app.useatlas.dev)",
      "--api-key": "API key for the target workspace",
    },
  },
  completions: {
    description: "Output shell completion script",
    flags: {},
  },
};

const COMMAND_NAMES = Object.keys(COMMANDS);

/** Escape a string for use inside single quotes in fish shell. */
function fishEscape(s: string): string {
  return s.replace(/'/g, "\\'");
}

export function generateBashCompletions(): string {
  const commandFlags: string[] = [];
  for (const [cmd, spec] of Object.entries(COMMANDS)) {
    const flags = Object.keys(spec.flags).join(" ");
    commandFlags.push(`      ${cmd}) COMPREPLY=( $(compgen -W "${flags}" -- "$cur") ) ;;`);
  }

  return `# Atlas CLI bash completions
# Add to ~/.bashrc:
#   eval "$(atlas completions bash)"

_atlas_completions() {
  local cur prev words cword
  if type _init_completion &>/dev/null; then
    _init_completion || return
  else
    cur="\${COMP_WORDS[COMP_CWORD]}"
    cword=$COMP_CWORD
    words=("\${COMP_WORDS[@]}")
  fi

  local commands="${COMMAND_NAMES.join(" ")}"

  # Complete commands at position 1
  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return
  fi

  # Complete flags based on the command
  local cmd="\${words[1]}"
  case "$cmd" in
${commandFlags.join("\n")}
  esac
}

complete -F _atlas_completions atlas
`;
}

export function generateZshCompletions(): string {
  const commandDescriptions = COMMAND_NAMES.map(
    (cmd) => `    '${cmd}:${COMMANDS[cmd].description.replace(/'/g, "\\'")}'`,
  ).join("\n");

  const commandCases: string[] = [];
  for (const [cmd, spec] of Object.entries(COMMANDS)) {
    const flags = Object.entries(spec.flags);
    if (flags.length === 0) {
      commandCases.push(`    ${cmd}) ;;`);
      continue;
    }
    const flagArgs = flags
      .map(([flag, desc]) => `      '${flag}[${desc.replace(/'/g, "\\'")}]'`)
      .join(" \\\n");
    commandCases.push(`    ${cmd})\n      _arguments -s \\\n${flagArgs}\n      ;;`);
  }

  return `#compdef atlas
# Atlas CLI zsh completions
# Add to ~/.zshrc:
#   eval "$(atlas completions zsh)"

_atlas() {
  local -a commands
  commands=(
${commandDescriptions}
  )

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
${commandCases.join("\n")}
      esac
      ;;
  esac
}

compdef _atlas atlas
`;
}

export function generateFishCompletions(): string {
  const lines: string[] = [
    "# Atlas CLI fish completions",
    "# Save to ~/.config/fish/completions/atlas.fish:",
    "#   atlas completions fish > ~/.config/fish/completions/atlas.fish",
    "",
    "# Disable file completions by default",
    "complete -c atlas -f",
    "",
    "# Commands (only when no subcommand yet)",
  ];

  for (const [cmd, spec] of Object.entries(COMMANDS)) {
    lines.push(
      `complete -c atlas -n '__fish_use_subcommand' -a '${cmd}' -d '${fishEscape(spec.description)}'`,
    );
  }

  lines.push("");
  lines.push("# Flags per command");

  for (const [cmd, spec] of Object.entries(COMMANDS)) {
    for (const [flag, desc] of Object.entries(spec.flags)) {
      const long = flag.replace(/^--/, "");
      lines.push(
        `complete -c atlas -n '__fish_seen_subcommand_from ${cmd}' -l '${long}' -d '${fishEscape(desc)}'`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

export function generateCompletions(shell: Shell): string {
  switch (shell) {
    case "bash":
      return generateBashCompletions();
    case "zsh":
      return generateZshCompletions();
    case "fish":
      return generateFishCompletions();
  }
}

const SUPPORTED_SHELLS: Shell[] = ["bash", "zsh", "fish"];

export function handleCompletions(args: string[]): void {
  const shell = args[1] as string | undefined;

  if (!shell || !SUPPORTED_SHELLS.includes(shell as Shell)) {
    console.error(
      "Usage: atlas completions <bash|zsh|fish>\n\n" +
        "Output a shell completion script.\n\n" +
        "Installation:\n" +
        '  bash:  eval "$(atlas completions bash)"     # Add to ~/.bashrc\n' +
        '  zsh:   eval "$(atlas completions zsh)"      # Add to ~/.zshrc\n' +
        "  fish:  atlas completions fish > ~/.config/fish/completions/atlas.fish",
    );
    process.exit(1);
  }

  process.stdout.write(generateCompletions(shell as Shell));
}
