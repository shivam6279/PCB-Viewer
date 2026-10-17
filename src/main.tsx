import "./app/app.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./app/App"

// The deploy's preview renderer drives the site from outside (tools/render-previews.mjs).
if (new URLSearchParams(location.search).has("render-previews")) void import("./app/preview-render-hook")

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
