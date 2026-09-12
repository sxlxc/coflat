import { defineConfig } from "vite";

const repository = process.env.GITHUB_REPOSITORY?.split("/")[1];

export default defineConfig({
  root: "examples/simple",
  base: repository ? `/${repository}/` : "/",
  build: {
    outDir: "../../dist-pages",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Cache the large editor dependencies separately from showcase code.
          groups: [
            { name: "codemirror", test: /node_modules\/(?:@codemirror|@lezer)\// },
            { name: "katex", test: /node_modules\/katex\// },
          ],
        },
      },
    },
  },
});
