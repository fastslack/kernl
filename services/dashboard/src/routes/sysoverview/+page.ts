import { redirect } from "@sveltejs/kit";

// Legacy /sysoverview, kept so old bookmarks and links still land. Merged into /system.
export function load(): never {
  redirect(307, "/system");
}
