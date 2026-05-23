import { defineConfig, envField } from "astro/config";

export default defineConfig({
  output: "static",
  server: {
    host: true, // bind to 0.0.0.0 so the dev server is reachable on the LAN
  },
  env: {
    schema: {
      // Empty string = serve scores from local /scores/ path (dev & local build).
      // Set to your R2 public URL for CloudFlare Pages deployment.
      PUBLIC_SCORES_BASE: envField.string({
        context: "client",
        access: "public",
        default: "",
      }),
    },
  },
});
