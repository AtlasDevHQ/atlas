import { describe, expect, test } from "bun:test";
import {
  COMMANDS,
  generateBashCompletions,
  generateZshCompletions,
  generateFishCompletions,
  generateCompletions,
  type Shell,
} from "../completions";

describe("completions", () => {
  const allCommands = Object.keys(COMMANDS);

  describe("COMMANDS registry", () => {
    test("includes all CLI commands", () => {
      const expected = [
        "init", "diff", "query", "doctor", "validate",
        "mcp", "migrate", "plugin", "eval", "smoke",
        "benchmark", "completions",
      ];
      for (const cmd of expected) {
        expect(allCommands).toContain(cmd);
      }
    });

    test("every command has a description", () => {
      for (const [_name, spec] of Object.entries(COMMANDS)) {
        expect(spec.description).toBeTruthy();
        expect(typeof spec.description).toBe("string");
      }
    });

    test("init has expected flags", () => {
      const flags = Object.keys(COMMANDS.init.flags);
      expect(flags).toContain("--tables");
      expect(flags).toContain("--schema");
      expect(flags).toContain("--enrich");
      expect(flags).toContain("--no-enrich");
      expect(flags).toContain("--demo");
      expect(flags).toContain("--csv");
      expect(flags).toContain("--parquet");
    });

    test("query has expected flags", () => {
      const flags = Object.keys(COMMANDS.query.flags);
      expect(flags).toContain("--json");
      expect(flags).toContain("--csv");
      expect(flags).toContain("--quiet");
      expect(flags).toContain("--connection");
    });
  });

  describe("generateBashCompletions", () => {
    const script = generateBashCompletions();

    test("contains bash function and complete registration", () => {
      expect(script).toContain("_atlas_completions()");
      expect(script).toContain("complete -F _atlas_completions atlas");
    });

    test("lists all command names", () => {
      for (const cmd of allCommands) {
        expect(script).toContain(cmd);
      }
    });

    test("includes case branches for commands with flags", () => {
      expect(script).toContain("init)");
      expect(script).toContain("query)");
      expect(script).toContain("--tables");
    });
  });

  describe("generateZshCompletions", () => {
    const script = generateZshCompletions();

    test("contains compdef directive", () => {
      expect(script).toContain("#compdef atlas");
    });

    test("contains _atlas function", () => {
      expect(script).toContain("_atlas()");
      expect(script).toContain('_atlas "$@"');
    });

    test("lists commands with descriptions", () => {
      for (const [cmd, spec] of Object.entries(COMMANDS)) {
        expect(script).toContain(`'${cmd}:${spec.description}'`);
      }
    });

    test("includes flag arguments for commands", () => {
      expect(script).toContain("--tables");
      expect(script).toContain("--json");
    });
  });

  describe("generateFishCompletions", () => {
    const script = generateFishCompletions();

    test("disables file completions", () => {
      expect(script).toContain("complete -c atlas -f");
    });

    test("registers all commands with __fish_use_subcommand", () => {
      for (const [cmd, spec] of Object.entries(COMMANDS)) {
        expect(script).toContain(
          `complete -c atlas -n '__fish_use_subcommand' -a '${cmd}' -d '${spec.description}'`,
        );
      }
    });

    test("registers flags per command", () => {
      expect(script).toContain("__fish_seen_subcommand_from init");
      expect(script).toContain("-l 'tables'");
      expect(script).toContain("__fish_seen_subcommand_from query");
      expect(script).toContain("-l 'json'");
    });
  });

  describe("generateCompletions", () => {
    test("dispatches to correct generator", () => {
      const shells: Shell[] = ["bash", "zsh", "fish"];
      for (const shell of shells) {
        const result = generateCompletions(shell);
        expect(result.length).toBeGreaterThan(0);
      }
    });

    test("bash output matches generateBashCompletions", () => {
      expect(generateCompletions("bash")).toBe(generateBashCompletions());
    });

    test("zsh output matches generateZshCompletions", () => {
      expect(generateCompletions("zsh")).toBe(generateZshCompletions());
    });

    test("fish output matches generateFishCompletions", () => {
      expect(generateCompletions("fish")).toBe(generateFishCompletions());
    });
  });
});
