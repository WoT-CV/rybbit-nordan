export class SessionReplayNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session replay not found for session ${sessionId}`);
    this.name = "SessionReplayNotFoundError";
  }
}
