/**
 * Workspace-level command registry.
 *
 * Commands are named, idempotent-by-contract actions (e.g. navigation
 * commands for back/forward). Registration returns a disposer so command
 * lifecycle is owned by the registering effect scope.
 */

import { FroglightError } from './errors.js';

export interface Command {
  /** Stable command id, e.g. `froglight.navigation.back`. */
  readonly id: string;
  readonly title?: string;
  /** Execute the command. Errors are captured in the result, not thrown. */
  readonly execute: () => unknown | Promise<unknown>;
}

export type CommandResult = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

export interface CommandService {
  /** Register a command; throws `DUPLICATE_COMMAND` on id collision. */
  register(command: Command): Disposer;
  /** Unregister by id; no-op when absent. */
  unregister(id: string): void;
  /** Get a command; throws `COMMAND_NOT_FOUND` when absent. */
  get(id: string): Command;
  /** All registered command ids, sorted. */
  list(): readonly string[];
  /** Execute by id; captures failures instead of throwing. */
  execute(id: string): Promise<CommandResult>;
}

export interface Disposer {
  readonly dispose: () => void;
}

/** In-memory command registry. */
export class InMemoryCommandService implements CommandService {
  readonly #commands = new Map<string, Command>();

  register(command: Command): Disposer {
    if (this.#commands.has(command.id)) {
      throw new FroglightError('DUPLICATE_COMMAND', `command already registered: ${command.id}`);
    }
    this.#commands.set(command.id, command);
    return {
      dispose: () => {
        this.unregister(command.id);
      },
    };
  }

  unregister(id: string): void {
    this.#commands.delete(id);
  }

  get(id: string): Command {
    const command = this.#commands.get(id);
    if (command === undefined) {
      throw new FroglightError('COMMAND_NOT_FOUND', `no command with id ${id}`);
    }
    return command;
  }

  list(): readonly string[] {
    return [...this.#commands.keys()].sort();
  }

  async execute(id: string): Promise<CommandResult> {
    const command = this.#commands.get(id);
    if (command === undefined) {
      return { ok: false, error: new FroglightError('COMMAND_NOT_FOUND', `no command with id ${id}`) };
    }
    try {
      await command.execute();
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }
}
