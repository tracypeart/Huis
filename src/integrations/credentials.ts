/**
 * Sign-in tokens for integrations are sealed under their own label, so a
 * mailbox token can't be swapped in for a OneDrive one (or the reverse).
 */
export const credentialId = (firmId: string, provider: string, subject: string) =>
  ({ firmId, provider: `integration:${provider}`, subject });
