import "../app/app.css"
import "./embed.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Embed } from "./Embed"

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Embed />
	</StrictMode>,
)
