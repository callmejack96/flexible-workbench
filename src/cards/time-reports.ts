import { renderTimeReports } from "../todo-reports";
import type { CardDefinition } from "./definition";

export const timeReportsCard: CardDefinition<"time-reports"> = {
	kind: "time-reports",
	templates: [
		{
			id: "time-reports",
			name: "Time reports",
			icon: "bar-chart-3",
			build: () => ({ kind: "time-reports", title: "Time reports", w: 6, h: 4 }),
		},
	],
	render: (view, card, body, component) => renderTimeReports(view, card, body, component),
	liveness: { mode: "static" },
};
