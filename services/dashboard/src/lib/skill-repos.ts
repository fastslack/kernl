/**
 * Git repositories worth subscribing to, offered as one click in the
 * "Add catalog repository" modal.
 *
 * The problem this solves is narrow and real: subscribing works fine, but it
 * asks for a URL, and nobody knows a skills repo URL by heart. Without a
 * starting point the catalog stays empty and every other skill feature has
 * nothing to operate on.
 *
 * ## Every entry here has been scanned before it was added
 *
 * Not "looks reputable" — actually subscribed against a running kernel and
 * checked for a non-zero item count. This matters more than it sounds,
 * because the most obvious candidates fail: a repo can be the top result for
 * "agent skills", advertise a thousand of them, and yield exactly zero.
 * `VoltAgent/awesome-agent-skills` and `travisvn/awesome-claude-skills` are
 * both indexes — curated README tables linking to skills that live in other
 * repositories — so a clone of them contains no `SKILL.md` at all. That is
 * correct behaviour on our side and a dead end for the user, which is why
 * the modal warns when a fresh subscription finds nothing.
 *
 * To add one: subscribe it, confirm the count, then write the row.
 *
 * ## Order is a trust signal, so keep it deliberate
 *
 * A skill is instructions that go into the model's prompt, and listing a
 * repository here reads as an endorsement of whoever wrote them. The order
 * below runs from the official Anthropic set, through collections with a
 * named author behind them, to broad community grab-bags — largest last, not
 * first. Size is the weakest of the reasons to trust something, and the
 * biggest entry here carries more third-party prompt text than the other four
 * combined. `prompt-sanitizer.ts` scrubs what it can on the way in; it does
 * not make the content trustworthy.
 *
 * `items` is approximate on purpose. These repositories grow, and a stale
 * exact number reads as a bug in a way that a stale "~20" does not.
 */

export interface SuggestedRepo {
	/** Clone URL, exactly as it goes to `POST /api/marketplace/repos`. */
	url: string;
	/** Display name — also sent as the repo's label so the list stays tidy. */
	name: string;
	/** What the repo is for, in one line. */
	blurb: string;
	/** Roughly how many skills it carried when it was last verified. */
	items: number;
	/** ISO date of that check, so a reviewer knows how old the number is. */
	verified: string;
}

export const SUGGESTED_SKILL_REPOS: SuggestedRepo[] = [
	{
		url: 'https://github.com/anthropics/skills',
		name: 'Anthropic Skills',
		blurb: 'Official. Office documents (docx, pdf, pptx, xlsx), frontend-design, mcp-builder, skill-creator.',
		items: 20,
		verified: '2026-08-19',
	},
	{
		url: 'https://github.com/coreyhaines31/marketingskills',
		name: 'Marketing Skills',
		blurb: 'Positioning, copywriting, SEO, ads, launches and campaign work.',
		items: 49,
		verified: '2026-08-19',
	},
	{
		url: 'https://github.com/mattpocock/skills',
		name: 'Matt Pocock — Engineering',
		blurb: 'Code review, diagnosing bugs, domain modelling, codebase design. Written for TypeScript work.',
		items: 35,
		verified: '2026-08-20',
	},
	{
		url: 'https://github.com/glebis/claude-skills',
		name: 'Gleb Kalinin — Personal workflows',
		blurb: 'One practitioner\'s day-to-day set: browsing history, meeting and coaching summaries, automation advice, publishing.',
		items: 108,
		verified: '2026-08-20',
	},
	{
		url: 'https://github.com/alirezarezvani/claude-skills',
		name: 'Community — Business & engineering',
		blurb: 'Broad grab-bag: API and architecture review, analytics, app-store work, compliance and audit readiness.',
		items: 236,
		verified: '2026-08-20',
	},
];

/** True when this repo is already subscribed, comparing without the noise. */
export function isSubscribed(repo: SuggestedRepo, subscribed: { url: string }[]): boolean {
	const norm = (u: string) => u.trim().replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
	return subscribed.some((r) => norm(r.url) === norm(repo.url));
}
