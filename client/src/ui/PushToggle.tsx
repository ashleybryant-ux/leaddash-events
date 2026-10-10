import { useState } from "react";
import { trpc } from "../lib/trpc";
import { isIOS, pushState, subscribePush, type PushState } from "../lib/push";
import { errorText, toast } from "./toast";

/** "Turn on notifications" row. On iPhone it explains adding the app to the Home Screen first. */
export function PushToggle() {
  const key = trpc.core.push.publicKey.useQuery();
  const save = trpc.core.push.subscribe.useMutation();
  const [state, setState] = useState<PushState>(() => pushState());
  if (!key.data?.key) return null;
  return (
    <div className="tile" style={{ alignItems: "center" }}>
      <div className="grow col" style={{ gap: 2 }}>
        <span className="strong">Notifications</span>
        <span className="small muted">
          {state === "granted"
            ? "On for this device"
            : state === "denied"
              ? "Blocked. Turn them on in your phone's settings for this app."
              : state === "needs-install"
                ? "Add the app to your Home Screen first, then turn them on."
                : state === "unsupported"
                  ? isIOS()
                    ? "Update to iOS 16.4 or later to get notifications."
                    : "This browser does not support notifications."
                  : "Session reminders and event updates"}
        </span>
      </div>
      {state === "default" ? (
        <button
          className="btn btn-sm btn-w"
          onClick={async () => {
            try {
              const sub = await subscribePush(key.data!.key!);
              setState(pushState());
              if (sub) {
                await save.mutateAsync(sub);
                toast("Notifications are on");
              }
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Turn on
        </button>
      ) : null}
    </div>
  );
}
