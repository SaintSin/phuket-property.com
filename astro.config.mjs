// @ts-check
import { defineConfig } from "astro/config";

import sitemap from "@astrojs/sitemap";
import icon from "astro-icon";

// https://astro.build/config
export default defineConfig({
  image: {
    responsiveStyles: true,
  },
  integrations: [sitemap(), icon()],
  site: "http://localhost/",
});
