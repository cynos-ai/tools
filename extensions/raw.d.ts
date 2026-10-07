// Vite/vitest-style raw-text imports. Used to inline the annotate overlay JS
// source into the bundle (esbuild gets the matching plugin in scripts/build.mjs;
// vitest supports `?raw` natively).
declare module "*?raw" {
  const content: string;
  export default content;
}
