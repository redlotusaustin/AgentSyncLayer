/**
 * Input validation for AgentBus tools
 *
 * Validates channel names, file paths, and message content
 * according to the rules specified in contract.md.
 */

import type { ErrorCode } from './types';

/** Channel name pattern: 1-64 alphanumeric, hyphen, underscore chars */
const CHANNEL_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Maximum message length */
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Validation error class with code
 */
export class ValidationException extends Error {
  public readonly code: ErrorCode;
  public readonly isValidationError = true;

  constructor(message: string, code: ErrorCode) {
    super(message);
    this.name = 'ValidationException';
    this.code = code;
  }
}

/**
 * Rate limit error class
 */
export class RateLimitException extends Error {
  public readonly code: ErrorCode = 'RATE_LIMITED';
  public readonly isRateLimitError = true;

  constructor(message = 'Rate limit exceeded: max 10 messages per second') {
    super(message);
    this.name = 'RateLimitException';
  }
}

/**
 * Validate a channel name according to contract.md rules:
 * - Must match ^[a-zA-Z0-9_-]{1,64}$
 * - Normalized to lowercase
 *
 * @param name - The channel name to validate
 * @returns The normalized (lowercase, trimmed) channel name
 * @throws ValidationException if channel name is invalid
 */
export function validateChannel(name: string): string {
  const normalized = name.trim().toLowerCase();

  if (!CHANNEL_PATTERN.test(normalized)) {
    throw new ValidationException(
      'Invalid channel name: must be 1-64 alphanumeric/hyphen/underscore chars',
      'CHANNEL_INVALID'
    );
  }

  return normalized;
}

/**
 * Validate a message according to contract.md rules:
 * - Must be non-empty string
 * - Max 4096 characters
 *
 * @param text - The message text to validate
 * @returns The trimmed message text
 * @throws ValidationException if message is empty or too long
 */
export function validateMessage(text: string): string {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    throw new ValidationException('Message cannot be empty', 'MESSAGE_EMPTY');
  }

  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationException(
      `Message too long: max ${MAX_MESSAGE_LENGTH} characters`,
      'MESSAGE_TOO_LONG'
    );
  }

  return trimmed;
}

/**
 * Validate a file path according to contract.md rules:
 * - Must be relative (no leading /)
 * - No .. segments
 * - No empty path
 * - No double slashes
 *
 * @param path - The file path to validate
 * @returns The normalized file path
 * @throws ValidationException if path is invalid
 */
export function validateFilePath(path: string): string {
  // Normalize backslashes to forward slashes
  const normalized = path.trim().replace(/\\/g, '/');

  if (normalized.length === 0) {
    throw new ValidationException('File path cannot be empty', 'PATH_INVALID');
  }

  if (normalized.startsWith('/')) {
    throw new ValidationException(
      'File path must be relative (no leading slash)',
      'PATH_INVALID'
    );
  }

  if (normalized.includes('..')) {
    throw new ValidationException(
      "File path cannot contain '..' segments",
      'PATH_INVALID'
    );
  }

  if (normalized.includes('//')) {
    throw new ValidationException(
      'File path cannot contain double slashes',
      'PATH_INVALID'
    );
  }

  return normalized;
}

/**
 * Validate a message type is one of the allowed values
 *
 * @param type - The message type to validate
 * @returns The validated message type
 * @throws ValidationException if type is invalid
 */
export function validateMessageType(type: string): string {
  const validTypes = ['info', 'status', 'error', 'coordination', 'claim', 'release'];

  if (!validTypes.includes(type)) {
    throw new ValidationException(
      `Invalid message type: must be one of ${validTypes.join(', ')}`,
      'TYPE_INVALID'
    );
  }

  return type;
}

/**
 * Clamp a number to a range
 *
 * @param value - The value to clamp
 * @param min - Minimum allowed value
 * @param max - Maximum allowed value
 * @returns The clamped value
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Check if a string is a valid UUID v4
 *
 * @param str - The string to check
 * @returns True if valid UUID v4 format
 */
export function isValidUUID(str: string): boolean {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidPattern.test(str);
}

/**
 * Check if a string is a valid agent ID
 * Pattern: hostname-pid-random4hex
 * Regex: ^[a-zA-Z0-9._-]+-[0-9]+-[a-f0-9]{4}$
 *
 * @param agentId - The agent ID to check
 * @returns True if valid agent ID format
 */
export function isValidAgentId(agentId: string): boolean {
  const agentIdPattern = /^[a-zA-Z0-9._-]+-[0-9]+-[a-f0-9]{4}$/;
  return agentIdPattern.test(agentId);
}

/**
 * Check if a string is a valid project hash
 * Pattern: 12-character lowercase hex string
 *
 * @param hash - The hash to check
 * @returns True if valid project hash format
 */
export function isValidProjectHash(hash: string): boolean {
  const hashPattern = /^[a-f0-9]{12}$/;
  return hashPattern.test(hash);
}

/**
 * Validate listen timeout value (1-30 seconds)
 *
 * @param timeout - The timeout value to validate
 * @returns The validated and clamped timeout
 * @throws ValidationException if timeout is invalid
 */
export function validateTimeout(timeout: number): number {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30) {
    throw new ValidationException(
      'Invalid timeout: must be an integer between 1 and 30 seconds',
      'TIMEOUT_INVALID'
    );
  }
  return timeout;
}

/**
 * Validate read limit value (1-100 messages)
 *
 * @param limit - The limit value to validate
 * @returns The validated and clamped limit
 * @throws ValidationException if limit is invalid
 */
export function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationException(
      'Invalid limit: must be an integer between 1 and 100',
      'LIMIT_INVALID'
    );
  }
  return limit;
}
