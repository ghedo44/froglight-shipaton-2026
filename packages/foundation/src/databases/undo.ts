/** A bounded, one-shot inverse for one committed logical database operation. */
export interface DatabaseUndoOperation {
  readonly label: string;
  undo(): Promise<void>;
}

export class DatabaseUndoConflictError extends Error {
  constructor(
    message = 'Database changed after this operation. Refresh before retrying.',
  ) {
    super(message);
    this.name = 'DatabaseUndoConflictError';
  }
}

export function databaseUndoOperation(
  label: string,
  undo: () => Promise<void>,
): DatabaseUndoOperation {
  let started = false;
  return {
    label,
    async undo() {
      if (started)
        throw new Error('This database operation was already undone');
      started = true;
      await undo();
    },
  };
}
