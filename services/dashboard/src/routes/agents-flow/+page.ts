// The agents-flow page renders a Three.js WebGL scene which references
// `window`/`document` as soon as a child component mounts. Both SSR and
// prerender try to evaluate the component on the server (where `window`
// doesn't exist) and crash with `ReferenceError: window is not defined`.
// Forcing SPA mode for this route lets the static adapter's index.html
// fallback serve it and the client mounts the Three.js scene normally.

export const ssr = false;
export const prerender = false;
