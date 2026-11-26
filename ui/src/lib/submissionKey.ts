/** Holds the Idempotency-Key of one submission. The key is created on the
 *  first attempt and kept for a retry of the same payload that failed with a
 *  network error or a 5xx; success, a 4xx or a changed payload gets a new key.
 *  (Errors are told apart by their numeric `status`, which ApiError carries.) */
export class SubmissionKey {
  private key = ''
  private fingerprint = ''

  /** Key for a submission with this payload (a stable string). */
  next(fingerprint: string): string {
    if (!this.key || this.fingerprint !== fingerprint) {
      this.key = crypto.randomUUID()
      this.fingerprint = fingerprint
    }
    return this.key
  }

  /** Call when the request settled: no argument on success, else the error. */
  settle(err?: unknown): void {
    const status = (err as { status?: unknown } | null | undefined)?.status
    const retryable = err !== undefined && (typeof status !== 'number' || status >= 500)
    if (!retryable) this.key = ''
  }
}
