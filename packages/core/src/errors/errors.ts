/**
 * Concrete error types (EH-2). Each fixes a category and sensible defaults so
 * call sites stay terse.
 */

import { AnvayaError, type AnvayaErrorOptions } from './base.js';
import { ERROR_CODES } from './codes.js';

type Partialize = Partial<AnvayaErrorOptions>;

export class ValidationError extends AnvayaError {
  constructor(message: string, options: Partialize = {}) {
    super(message, {
      code: ERROR_CODES.VALIDATION_FAILED,
      ...options,
      category: 'validation',
    });
  }
}

export class ConfigurationError extends AnvayaError {
  constructor(message: string, options: Partialize = {}) {
    super(message, {
      code: ERROR_CODES.CONFIG_INVALID,
      ...options,
      category: 'configuration',
    });
  }
}

export class StorageError extends AnvayaError {
  constructor(message: string, options: Partialize = {}) {
    super(message, {
      code: ERROR_CODES.STORAGE_QUERY_FAILED,
      ...options,
      category: 'storage',
    });
  }
}

export class TransportError extends AnvayaError {
  constructor(message: string, options: Partialize = {}) {
    super(message, {
      code: ERROR_CODES.TRANSPORT_FAILED,
      ...options,
      category: 'transport',
    });
  }
}

export class DetectorError extends AnvayaError {
  constructor(message: string, options: Partialize = {}) {
    super(message, {
      code: ERROR_CODES.DETECTOR_FAILED,
      ...options,
      category: 'detector',
    });
  }
}

export class AuthError extends AnvayaError {
  constructor(message: string, options: Partialize = {}) {
    super(message, {
      code: ERROR_CODES.AUTH_INVALID,
      ...options,
      category: 'auth',
    });
  }
}

export class NotFoundError extends AnvayaError {
  constructor(message: string, options: Partialize = {}) {
    super(message, {
      code: ERROR_CODES.NOT_FOUND,
      ...options,
      category: 'not_found',
    });
  }
}

export class RateLimitError extends AnvayaError {
  constructor(message: string, options: Partialize = {}) {
    super(message, {
      code: ERROR_CODES.RATE_LIMITED,
      ...options,
      category: 'rate_limit',
    });
  }
}

export class InternalError extends AnvayaError {
  constructor(message: string, options: Partialize = {}) {
    super(message, {
      code: ERROR_CODES.INTERNAL,
      ...options,
      category: 'internal',
    });
  }
}
