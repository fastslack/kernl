/**
 * What an office is, as the dashboard needs it: the room it gets in 3D and the
 * buttons its agents show. Mirrors FLOW_KINDS in the kernel
 * (services/kernel/src/modules/agents/types.ts). An unknown or missing kind
 * reads as 'general', so a newer kernel never breaks this dashboard.
 */
export const OFFICE_KINDS = ['general', 'devops', 'communications', 'creative'] as const;
export type OfficeKind = (typeof OFFICE_KINDS)[number];

export type RoomTheme = 'standard' | 'data-center' | 'communications';

export interface OfficeKindTraits {
	/** Which room builder the 3D world uses. */
	theme: RoomTheme;
	/** The agent drawer offers the DevOps panel (/devops). */
	devopsLink: boolean;
	/** The agent drawer offers the live Scene Studio preview. */
	liveScene: boolean;
	/** Mail deliveries (comms:mail:received) drive to this office. */
	receivesMail: boolean;
}

const TRAITS: Record<OfficeKind, OfficeKindTraits> = {
	general: { theme: 'standard', devopsLink: false, liveScene: false, receivesMail: false },
	devops: { theme: 'data-center', devopsLink: true, liveScene: false, receivesMail: false },
	communications: { theme: 'communications', devopsLink: false, liveScene: false, receivesMail: true },
	creative: { theme: 'standard', devopsLink: false, liveScene: true, receivesMail: false },
};

export function isOfficeKind(v: unknown): v is OfficeKind {
	return typeof v === 'string' && (OFFICE_KINDS as readonly string[]).includes(v);
}

export function officeKindOf(flow: { kind?: string | null } | null | undefined): OfficeKind {
	const kind = flow?.kind;
	return isOfficeKind(kind) ? kind : 'general';
}

export function kindTraits(kind: OfficeKind): OfficeKindTraits {
	return TRAITS[kind];
}

export function traitsOf(flow: { kind?: string | null } | null | undefined): OfficeKindTraits {
	return TRAITS[officeKindOf(flow)];
}

/** The office the mail truck drives to. */
export function mailOffice<T extends { kind?: string | null }>(flows: T[]): T | undefined {
	return flows.find((f) => traitsOf(f).receivesMail);
}
