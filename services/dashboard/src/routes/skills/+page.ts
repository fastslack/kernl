import { redirect } from "@sveltejs/kit";

// Legacy /skills, kept so old bookmarks and links still land. Skills are extensions, managed in /extensions → Skills.
export function load(): never {
  redirect(307, "/extensions?tab=skills");
}
