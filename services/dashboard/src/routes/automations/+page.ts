import { redirect } from "@sveltejs/kit";

// Legacy /automations, kept so old bookmarks and links still land. Now the Automation tab of /system.
export function load(): never {
  redirect(307, "/system?tab=automation");
}
