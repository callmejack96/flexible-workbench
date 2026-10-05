import { renderTimeTracker } from "../time-tracking";
import type { HomeView } from "../view";
import type { CardDefinition } from "./definition";

/** Flexible Workbench's built-in time tracker. All timer state is local. */
export const timerCard: CardDefinition<"timer"> = {
	kind: "timer",
	templates: [
		{
			id: "timer",
			name: "Time tracker",
			icon: "timer",
			build: () => ({ kind: "timer", title: "Time tracker", w: 3, h: 2 }),
		},
	],
	render: (view: HomeView, _card, body, component) => renderTimeTracker(view, body, component),
	liveness: { mode: "static" },
};
