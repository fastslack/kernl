// Extension page host — client-only: bundles are mounted into live DOM and
// fetched from the kernel at runtime, so there is nothing to prerender.
export const ssr = false;
export const prerender = false;
