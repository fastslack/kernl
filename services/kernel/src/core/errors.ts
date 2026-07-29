export class KernelError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "KernelError";
  }
}

export class ModuleError extends KernelError {
  constructor(
    public readonly module: string,
    message: string,
  ) {
    super(message, "MODULE_ERROR");
    this.name = "ModuleError";
  }
}

export class DatabaseError extends KernelError {
  constructor(message: string) {
    super(message, "DB_ERROR");
    this.name = "DatabaseError";
  }
}

export class ValidationError extends KernelError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}
