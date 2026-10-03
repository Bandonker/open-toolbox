/**
 * Shared command registry — plugins can register slash commands here
 * and command-pack will pick them up at setup time.
 */

export type CommandBuild = (args: string, available: ReadonlySet<string>) => string;

export type CommandSpec = {
  description: string;
  requires: string[];
  build: CommandBuild;
};

const registry = new Map<string, CommandSpec>();

export function registerCommand(name: string, spec: CommandSpec): void {
  registry.set(name, spec);
}

export function getRegisteredCommands(): ReadonlyMap<string, CommandSpec> {
  return registry;
}
