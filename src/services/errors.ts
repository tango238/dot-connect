export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

export class ConflictError extends Error {
  readonly data?: Record<string, unknown>

  constructor(message: string, data?: Record<string, unknown>) {
    super(message)
    this.name = 'ConflictError'
    this.data = data
  }
}
