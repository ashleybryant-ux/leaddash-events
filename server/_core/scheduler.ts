import { allJobs } from "../areas";
import { runOutbox } from "./platform";
import { ENV } from "./env";

let running = false;

/** Every minute: area jobs (reminders, scheduled announcements, follow-up messages) and the platform outbox. */
export function startScheduler() {
  if (ENV.noScheduler || ENV.isTest) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const job of [...allJobs(), { name: "platform outbox", run: runOutbox }]) {
        try {
          await job.run();
        } catch (err) {
          console.error(`[job:${job.name}]`, err);
        }
      }
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 10_000);
  setInterval(tick, 60_000);
}
