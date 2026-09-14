// The client project's files are Vite-built and use import.meta.glob, a
// Vite-only build-time API with no standard type. We never call it (it's
// only present because a client file we type-import from transitively
// references it in an unrelated code path) - this just satisfies the type
// checker so a Workers-only tsconfig (no vite/client types) doesn't error
// on syntax it will never actually execute.
interface ImportMeta {
  glob: (pattern: string, options?: Record<string, unknown>) => Record<string, unknown>;
}
