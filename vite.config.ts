import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
	plugins: [react()],
	worker: { format: "es" },
	base: "./",
	optimizeDeps: { include: ["altiumts", "comlink", "fflate", "three", "occt-import-js", "idb-keyval", "three-mesh-bvh", "clipper-lib", "earcut"] },
})
