const PAGE_SIZE = 100;
const MAX_SCANNED_INVITATIONS = 10_000;
const LOCAL_INVITATION_METADATA_KEY = "hartlibWorkspaceInvitationId";

type OrganizationRole = "org:admin" | "org:member";
type InvitationStatus = "pending" | "accepted";

interface RemoteOrganizationInvitation {
  readonly id: string;
  readonly organizationId: string;
  readonly emailAddress: string;
  readonly role: string;
  readonly expiresAt: number;
  readonly status?: string | undefined;
  readonly privateMetadata: Readonly<Record<string, unknown>>;
}

export interface ClerkOrganizationInvitationApi {
  readonly getOrganizationInvitationList: (input: {
    readonly organizationId: string;
    readonly status: InvitationStatus[];
    readonly limit: number;
    readonly offset: number;
  }) => Promise<{
    readonly data: readonly RemoteOrganizationInvitation[];
    readonly totalCount: number;
  }>;
  readonly createOrganizationInvitation: (input: {
    readonly organizationId: string;
    readonly emailAddress: string;
    readonly role: OrganizationRole;
    readonly inviterUserId: string;
    readonly redirectUrl: string;
    readonly privateMetadata: Readonly<Record<string, unknown>>;
  }) => Promise<RemoteOrganizationInvitation>;
}

export interface ClerkInvitationInput {
  readonly organizationId: string;
  readonly email: string;
  readonly role: OrganizationRole;
  readonly inviterUserId: string;
  readonly redirectUrl: string;
  readonly workspaceInvitationId: string;
}

export interface ClerkInvitationDelivery {
  readonly externalId: string;
  readonly expiresAt: Date;
}

const normalizedEmail = (value: string): string => value.trim().toLowerCase();

const deliveryFrom = (
  invitation: RemoteOrganizationInvitation,
  input: ClerkInvitationInput,
): ClerkInvitationDelivery => {
  if (
    invitation.organizationId !== input.organizationId ||
    normalizedEmail(invitation.emailAddress) !== normalizedEmail(input.email) ||
    invitation.role !== input.role ||
    invitation.id.trim() === "" ||
    !Number.isFinite(invitation.expiresAt) ||
    (invitation.status !== "pending" && invitation.status !== "accepted")
  ) {
    throw new Error("clerk_invitation_identity_mismatch");
  }
  const expiresAt = new Date(invitation.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("clerk_invitation_expiry_invalid");
  }
  return { externalId: invitation.id, expiresAt };
};

const findExisting = async (
  api: ClerkOrganizationInvitationApi,
  input: ClerkInvitationInput,
): Promise<ClerkInvitationDelivery | null> => {
  const matches: RemoteOrganizationInvitation[] = [];
  let offset = 0;
  let totalCount = 1;
  while (offset < totalCount) {
    const page = await api.getOrganizationInvitationList({
      organizationId: input.organizationId,
      status: ["pending", "accepted"],
      limit: PAGE_SIZE,
      offset,
    });
    if (
      !Number.isSafeInteger(page.totalCount) ||
      page.totalCount < 0 ||
      page.totalCount > MAX_SCANNED_INVITATIONS
    ) {
      throw new Error("clerk_invitation_scan_limit_invalid");
    }
    totalCount = page.totalCount;
    if (page.data.length === 0 && offset < totalCount) {
      throw new Error("clerk_invitation_pagination_incomplete");
    }
    for (const invitation of page.data) {
      if (
        invitation.privateMetadata[LOCAL_INVITATION_METADATA_KEY] === input.workspaceInvitationId
      ) {
        matches.push(invitation);
      }
    }
    offset += page.data.length;
  }
  if (matches.length > 1) throw new Error("clerk_invitation_identity_duplicate");
  return matches[0] === undefined ? null : deliveryFrom(matches[0], input);
};

interface InFlightInvitation {
  readonly fingerprint: string;
  readonly promise: Promise<ClerkInvitationDelivery>;
}

const inFlight = new Map<string, InFlightInvitation>();

const createOrRecover = async (
  api: ClerkOrganizationInvitationApi,
  input: ClerkInvitationInput,
): Promise<ClerkInvitationDelivery> => {
  const existing = await findExisting(api, input);
  if (existing !== null) return existing;
  try {
    const created = await api.createOrganizationInvitation({
      organizationId: input.organizationId,
      emailAddress: input.email,
      role: input.role,
      inviterUserId: input.inviterUserId,
      redirectUrl: input.redirectUrl,
      privateMetadata: { [LOCAL_INVITATION_METADATA_KEY]: input.workspaceInvitationId },
    });
    return deliveryFrom(created, input);
  } catch (createError) {
    const recovered = await findExisting(api, input);
    if (recovered !== null) return recovered;
    throw createError;
  }
};

export const createOrRecoverClerkOrganizationInvitation = (
  api: ClerkOrganizationInvitationApi,
  input: ClerkInvitationInput,
): Promise<ClerkInvitationDelivery> => {
  const key = `${input.organizationId}:${input.workspaceInvitationId}`;
  const fingerprint = JSON.stringify([
    input.organizationId,
    normalizedEmail(input.email),
    input.role,
    input.inviterUserId,
    input.redirectUrl,
    input.workspaceInvitationId,
  ]);
  const extant = inFlight.get(key);
  if (extant !== undefined) {
    return extant.fingerprint === fingerprint
      ? extant.promise
      : Promise.reject(new Error("clerk_invitation_identity_mismatch"));
  }
  const promise = createOrRecover(api, input);
  const tracked = { fingerprint, promise };
  inFlight.set(key, tracked);
  return promise.finally(() => {
    if (inFlight.get(key) === tracked) inFlight.delete(key);
  });
};
