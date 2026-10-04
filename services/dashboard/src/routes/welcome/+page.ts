import { redirect } from "@sveltejs/kit";

// Legacy /welcome, kept so old bookmarks and links still land. Superseded by the setup wizard; the layout's legacy kernl.welcomeSeen flow still lands here.
export function load(): never {
  redirect(307, "/setup");
}
