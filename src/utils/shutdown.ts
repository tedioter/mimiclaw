function rethrowCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError([...errors], message);
  }
}

export async function runShutdownSteps(
  steps: ReadonlyArray<() => Promise<void>>,
  message: string
): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  rethrowCollectedErrors(errors, message);
}
