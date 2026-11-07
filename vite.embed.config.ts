import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { resolve } from "path"

// The embeddable 3D board view (embed.html) alone, for a host app to serve: npx vite build -c vite.embed.config.ts
export default defineConfig({
	plugins: [react()],
	worker: { format: "es" },
	base: "./",
	publicDir: false, // the site's index and previews aren't needed here
	build: {
		outDir: "dist-embed",
		emptyOutDir: true,
		rollupOptions: { input: { embed: resolve(import.meta.dirname, "embed.html") } },
	},
})
