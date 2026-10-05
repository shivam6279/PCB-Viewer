import { LoaderCircle } from "lucide-react"

export function Spinner({ size = 14 }: { size?: number }) {
	return <LoaderCircle size={size} className="spin" aria-hidden />
}
