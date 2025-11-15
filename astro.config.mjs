// @ts-check

import netlify from "@astrojs/netlify";
import sitemap from "@astrojs/sitemap";
import { imageService } from "@unpic/astro/service";
import { defineConfig } from "astro/config";
import icon from "astro-icon";

// https://astro.build/config
export default defineConfig({
	image: {
		responsiveStyles: true,
		service: imageService(),
	},

	integrations: [sitemap(), icon()],
	site: "http://phuket-property.com/",
	adapter: netlify(),
});
