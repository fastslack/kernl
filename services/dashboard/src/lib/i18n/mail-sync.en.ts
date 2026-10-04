const en = {
  "mailsync.waiting.title": "Getting this mailbox ready",
  "mailsync.waiting.body": "Kernl hasn't downloaded {email} yet. The first check starts within {poll} minutes and brings in the {batch} most recent messages; after that, every check adds whatever new mail arrived.",
  "mailsync.connecting.title": "Connecting to the mail server…",
  "mailsync.connecting.body": "Kernl is signing in to {email} to see what's waiting.",
  "mailsync.downloading.title": "Downloading your mail",
  "mailsync.downloading.body": "{done} of {total} messages from {email}. They show up in the list as they arrive — no need to reload.",
  "mailsync.error.title": "Couldn't reach {email}",
  "mailsync.error.server": "The server said: {error}",
  "mailsync.error.auth_hint": "The password looks wrong. Fix it in Mail accounts and Kernl will pick it up on the next check.",
  "mailsync.error.retry_hint": "Kernl tries again on its own every {poll} minutes.",
  "mailsync.error.last_ok": "Last successful download: {ago}.",
  "mailsync.error.accounts_link": "Open Mail accounts",
  "mailsync.empty.title": "All caught up",
  "mailsync.empty.body": "Kernl checked {email} {ago} and the inbox on the server is empty. It looks again every {poll} minutes.",
  "mailsync.gmail.title": "Waiting for Gmail",
  "mailsync.gmail.body": "This account syncs through Google, not through the mail fetcher. Its messages appear after the next Gmail sync.",
  "mailsync.summary.title": "Some mailboxes are still loading",
  "mailsync.summary.pending": "Downloading",
  "mailsync.summary.failing": "Can't connect",
  "mailsync.summary.ready": "{n} ready",
  "mailsync.summary.hint": "Pick an account to see the details.",
  "mailbody.images_blocked": "{n} remote image(s) blocked. Loading them tells the sender you opened this email, when, and from where.",
  "mailbody.show_images": "Show images",
  "mailbody.view_text": "Plain text",
  "mailbody.view_html": "Formatted",
  "mailbody.empty": "(empty)",
};

/** Every key of the mail-sync banner strings. `mail-sync.es.ts` is typed against it. */
export type MailSyncKey = keyof typeof en;

export default en;
