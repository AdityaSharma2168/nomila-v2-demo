/**
 * agent/postKit/errors.ts — the post-kit service's one error: a status and a code the routes answer with. Its own file
 * so the routes module stays light (everything that touches the library is loaded on first use).
 */
export class PostKitError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
