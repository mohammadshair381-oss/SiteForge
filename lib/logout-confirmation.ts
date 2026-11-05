export type LogoutDialogState = "closed" | "open" | "submitting";

export type LogoutDialogEvent =
  | "OPEN"
  | "CANCEL"
  | "ESCAPE"
  | "BACKDROP"
  | "CONFIRM"
  | "FAILURE"
  | "COMPLETE";

export function logoutDialogReducer(
  state: LogoutDialogState,
  event: LogoutDialogEvent,
): LogoutDialogState {
  if (event === "OPEN" && state === "closed") return "open";
  if (
    (event === "CANCEL" || event === "ESCAPE" || event === "BACKDROP") &&
    state === "open"
  ) {
    return "closed";
  }
  if (event === "CONFIRM" && state === "open") return "submitting";
  if (event === "FAILURE" && state === "submitting") return "open";
  if (event === "COMPLETE" && state === "submitting") return "closed";
  return state;
}

export async function runLogoutOnce(
  inFlight: { current: boolean },
  request: () => Promise<void>,
  onSuccess: () => void,
): Promise<boolean> {
  if (inFlight.current) return false;
  inFlight.current = true;
  try {
    await request();
    onSuccess();
    return true;
  } finally {
    inFlight.current = false;
  }
}
