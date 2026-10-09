/**
 * Shared command registry — plugins can register slash commands here
 * and command-pack will pick them up at setup time.
 */
const registry = new Map();
export function registerCommand(name, spec) {
    registry.set(name, spec);
}
export function getRegisteredCommands() {
    return registry;
}
