import { defineConfig } from "vitest/config"

export default defineConfig({
	test: { include: ["tests/corpus/**/*.test.ts"], testTimeout: 600_000 },
})
