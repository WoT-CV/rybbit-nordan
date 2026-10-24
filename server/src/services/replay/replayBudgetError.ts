/** A retryable budget-state failure, never a terminal recording-size cap. */
export class ReplayBudgetUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Session replay budget reservations are temporarily unavailable");
    this.name = "ReplayBudgetUnavailableError";
  }
}
