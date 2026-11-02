/** Thrown when a signed-in user lacks permission. Safe to show to the user. */
export class PermissionDeniedError extends Error {
  constructor(public readonly permission: string) {
    super(`You do not have permission to ${permission.replace(/[._]/g, " ")}.`);
    this.name = "PermissionDeniedError";
  }
}

/** Thrown when a record does not exist OR the user may not see it. */
export class NotFoundError extends Error {
  constructor(what: string) {
    // Deliberately identical for "missing" and "hidden" so walled or other-firm
    // records cannot be probed for.
    super(`${what} not found.`);
    this.name = "NotFoundError";
  }
}

/** Thrown when the request has no valid firm/user context. */
export class UnauthenticatedError extends Error {
  constructor() {
    super("Your session is not valid. Please sign in again.");
    this.name = "UnauthenticatedError";
  }
}
