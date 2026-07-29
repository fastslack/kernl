// Comms status / channel color maps — local copy of the comms slice of
// services/dashboard/src/lib/constants.ts.

export const COMM_STATUS_COL: Record<string, string> = {
  draft: 'var(--gold)',
  ready: 'var(--green)',
  sending: 'var(--blue)',
  sent: 'var(--green)',
  failed: 'var(--red)',
  archived: 'var(--text-2)'
};

export const CHAN_COL: Record<string, string> = {
  email: 'var(--blue)',
  whatsapp: 'var(--green)',
  mattermost: 'var(--purple)',
  x: 'var(--text-1)',
  instagram: 'var(--orange)',
  linkedin: 'var(--blue)'
};
