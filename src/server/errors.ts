/** HTTP-mapped error thrown by API handlers; caught centrally in api.ts.
 * Lives in its own module so feature modules (hyperframes.ts, kimi.ts) can
 * throw it without importing the api dispatcher (circular import). */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
