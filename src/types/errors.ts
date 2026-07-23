export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export class MimiError extends Error {
  readonly code: string = "MIMI_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigError extends MimiError {
  readonly code = "CONFIG_ERROR";
}

export class ModelError extends MimiError {
  readonly code = "MODEL_ERROR";

  constructor(message: string, options?: ErrorOptions & { retryable?: boolean }) {
    super(message, options);
    this.retryable = options?.retryable === true;
  }

  readonly retryable: boolean;
}

export class MemoryStoreError extends MimiError {
  readonly code = "MEMORY_STORE_ERROR";
}

export class ToolError extends MimiError {
  readonly code = "TOOL_ERROR";
}

export class TimeoutError extends MimiError {
  readonly code = "TIMEOUT_ERROR";
}

export class PlatformError extends MimiError {
  readonly code = "PLATFORM_ERROR";
}
