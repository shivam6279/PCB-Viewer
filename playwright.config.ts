import { defineConfig } from "@playwright/test"

export default defineConfig({
	testDir: "e2e",
	timeout: 120_000,
	use: { baseURL: "http://localhost:4173", channel: "chrome" },
	webServer: { command: "npm run build && npm run preview", url: "http://localhost:4173", reuseExistingServer: true, timeout: 180_000 },
})
