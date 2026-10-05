// @vitest-environment jsdom
import "fake-indexeddb/auto"
import { afterEach, expect, test } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import App from "./App"
import { useAppStore } from "./store"

afterEach(cleanup)

test("starts on the start page", () => {
	useAppStore.setState({ screen: { kind: "start", error: null } })
	render(<App />)
	expect(screen.getByText(/Drop an Altium project folder or \.zip here/)).toBeTruthy()
	expect(screen.getByRole("button", { name: "Open .zip…" })).toBeTruthy()
})

test("shows errors on the start page", () => {
	useAppStore.setState({ screen: { kind: "start", error: "Boom" } })
	render(<App />)
	expect(screen.getByText("Boom")).toBeTruthy()
})

test("a corrupt zip shows an error instead of failing silently", async () => {
	useAppStore.setState({ screen: { kind: "start", error: null } })
	const { container } = render(<App />)
	fireEvent.change(screen.getByTestId("zip-input"), { target: { files: [new File([new Uint8Array([1, 2, 3])], "bad.zip")] } })
	await waitFor(() => expect(container.querySelector("[role=alert]")?.textContent ?? "").not.toBe(""))
})

test("the loading label is a status, not an error", () => {
	useAppStore.setState({ screen: { kind: "loading", label: "Opening x…" } })
	render(<App />)
	const label = screen.getByText("Opening x…")
	expect(label.closest("[role=alert]")).toBeNull()
})
