import { describe, expect, it, vi } from "vitest";

import {
  createOrRecoverClerkOrganizationInvitation,
  type ClerkInvitationInput,
  type ClerkOrganizationInvitationApi,
} from "./clerk-invitation-provider";

type RemoteInvitation = Awaited<
  ReturnType<ClerkOrganizationInvitationApi["createOrganizationInvitation"]>
>;

const input = (workspaceInvitationId = crypto.randomUUID()): ClerkInvitationInput => ({
  organizationId: "org_test",
  email: "person@example.test",
  role: "org:admin",
  inviterUserId: "user_inviter",
  redirectUrl: "https://hartlib.test/invitations/accept",
  workspaceInvitationId,
});

const remote = (
  request: ClerkInvitationInput,
  id = `orginv_${crypto.randomUUID()}`,
): RemoteInvitation => ({
  id,
  organizationId: request.organizationId,
  emailAddress: request.email,
  role: request.role,
  expiresAt: Date.parse("2026-08-01T00:00:00.000Z"),
  status: "pending",
  privateMetadata: { hartlibWorkspaceInvitationId: request.workspaceInvitationId },
});

const api = (
  invitations: RemoteInvitation[],
  create: ClerkOrganizationInvitationApi["createOrganizationInvitation"],
): ClerkOrganizationInvitationApi => ({
  getOrganizationInvitationList: async ({ organizationId, status, limit, offset }) => {
    const eligible = invitations.filter(
      (invitation) =>
        invitation.organizationId === organizationId &&
        invitation.status !== undefined &&
        status.includes(invitation.status as "pending" | "accepted"),
    );
    return { data: eligible.slice(offset, offset + limit), totalCount: eligible.length };
  },
  createOrganizationInvitation: create,
});

describe("recoverable Clerk organization invitation delivery", () => {
  it("recovers an existing remote invitation without creating a duplicate", async () => {
    const request = input();
    const invitations = [remote(request, "orginv_existing")];
    const create = vi.fn<ClerkOrganizationInvitationApi["createOrganizationInvitation"]>();

    await expect(
      createOrRecoverClerkOrganizationInvitation(api(invitations, create), request),
    ).resolves.toEqual({
      externalId: "orginv_existing",
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("recovers after the provider created remotely but returned an ambiguous failure", async () => {
    const request = input();
    const invitations: RemoteInvitation[] = [];
    const create = vi.fn<ClerkOrganizationInvitationApi["createOrganizationInvitation"]>(
      async () => {
        invitations.push(remote(request, "orginv_ambiguous"));
        throw new Error("socket_closed_after_commit");
      },
    );

    await expect(
      createOrRecoverClerkOrganizationInvitation(api(invitations, create), request),
    ).resolves.toMatchObject({ externalId: "orginv_ambiguous" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("coalesces identical concurrent attempts in one API process", async () => {
    const request = input();
    const invitations: RemoteInvitation[] = [];
    const create = vi.fn<ClerkOrganizationInvitationApi["createOrganizationInvitation"]>(
      async () => {
        await Promise.resolve();
        const invitation = remote(request, "orginv_concurrent");
        invitations.push(invitation);
        return invitation;
      },
    );
    const clerk = api(invitations, create);

    const deliveries = await Promise.all(
      Array.from({ length: 8 }, () => createOrRecoverClerkOrganizationInvitation(clerk, request)),
    );
    expect(new Set(deliveries.map((delivery) => delivery.externalId))).toEqual(
      new Set(["orginv_concurrent"]),
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it("scans all pages before deciding that a delivery is absent", async () => {
    const request = input();
    const invitations = Array.from({ length: 100 }, (_, index) =>
      remote(input(crypto.randomUUID()), `orginv_other_${index}`),
    );
    invitations.push(remote(request, "orginv_second_page"));
    const create = vi.fn<ClerkOrganizationInvitationApi["createOrganizationInvitation"]>();

    await expect(
      createOrRecoverClerkOrganizationInvitation(api(invitations, create), request),
    ).resolves.toMatchObject({ externalId: "orginv_second_page" });
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed on a duplicate or mismatched remote idempotency identity", async () => {
    const duplicateRequest = input();
    const duplicateApi = api(
      [remote(duplicateRequest, "orginv_1"), remote(duplicateRequest, "orginv_2")],
      vi.fn(),
    );
    await expect(
      createOrRecoverClerkOrganizationInvitation(duplicateApi, duplicateRequest),
    ).rejects.toThrow("clerk_invitation_identity_duplicate");

    const mismatchRequest = input();
    const mismatch = {
      ...remote(mismatchRequest, "orginv_mismatch"),
      emailAddress: "different@example.test",
    };
    await expect(
      createOrRecoverClerkOrganizationInvitation(api([mismatch], vi.fn()), mismatchRequest),
    ).rejects.toThrow("clerk_invitation_identity_mismatch");

    const statusRequest = input();
    const missingStatus = { ...remote(statusRequest, "orginv_status_missing"), status: undefined };
    await expect(
      createOrRecoverClerkOrganizationInvitation(
        {
          getOrganizationInvitationList: async () => ({ data: [missingStatus], totalCount: 1 }),
          createOrganizationInvitation: vi.fn(),
        },
        statusRequest,
      ),
    ).rejects.toThrow("clerk_invitation_identity_mismatch");
  });
});
