import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  ready: true,
  cloud: false,
  disableSignup: false as boolean | undefined,
  loading: false,
  invite: vi.fn(),
  create: vi.fn(),
}));
vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("@/lib/const", async original => ({
  ...(await original<object>()),
  get IS_CLOUD() {
    return state.cloud;
  },
}));
vi.mock("@/lib/configs", () => ({
  useConfigs: () => ({
    configs: state.loading ? undefined : { emailEnabled: state.ready, disableSignup: state.disableSignup },
  }),
}));
vi.mock("@/lib/auth", () => ({ authClient: { useSession: () => ({ data: null }) } }));
vi.mock("@/lib/roles", () => ({ useRoleInfo: () => (role: string) => ({ label: role }) }));
vi.mock("@/api/admin/hooks/useSites", () => ({ useGetSitesFromOrg: () => ({ data: { sites: [] } }) }));
vi.mock("@/api/admin/hooks/useTeams", () => ({ useTeams: () => ({ data: { teams: [] } }) }));
vi.mock("./personAccess", () => ({ accessForPeople: () => new Map(), invitationAccessKey: () => "invitation" }));
vi.mock("./InviteMemberDialog", () => ({
  InviteMemberDialog: ({ assignableRoles }: { assignableRoles: string[] }) => (
    <button onClick={() => state.invite(assignableRoles)}>Invite member</button>
  ),
}));
vi.mock("./CreateUserDialog", () => ({
  CreateUserDialog: ({ assignableRoles }: { assignableRoles: string[] }) => (
    <button onClick={() => state.create(assignableRoles)}>Create user</button>
  ),
}));
vi.mock("./EditMemberDialog", () => ({ EditMemberDialog: () => null }));
vi.mock("./Invitations", () => ({
  InvitationRow: ({ canResend }: { canResend: boolean }) => (
    <tr>
      <td>
        <button disabled={!canResend}>Resend invitation</button>
      </td>
    </tr>
  ),
}));
import { PeopleTable } from "./PeopleTable";

function table(canManageMembers = true, role = "member") {
  render(
    <PeopleTable
      organizationId="org1"
      members={[]}
      invitations={[{ id: "i1", email: "person@example.com", role }] as never}
      isLoading={false}
      canManageMembers={canManageMembers}
      assignableRoles={["member"]}
      onRefresh={vi.fn()}
      onInvitationsChanged={vi.fn()}
    />
  );
}
afterEach(() => {
  cleanup();
  state.ready = true;
  state.cloud = false;
  state.disableSignup = false;
  state.loading = false;
  vi.clearAllMocks();
});
describe("self-hosted invitations", () => {
  it.each(
    [false, true].flatMap(cloud =>
      [false, true].flatMap(ready => [false, true, undefined].map(disableSignup => ({ cloud, ready, disableSignup })))
    )
  )("preserves available onboarding for %j", configuration => {
    Object.assign(state, configuration);
    table();
    expect(!!screen.queryByRole("button", { name: "Invite member" })).toBe(state.cloud || state.ready);
    expect(!!screen.queryByRole("button", { name: "Create user" })).toBe(
      !state.cloud && (!state.ready || state.disableSignup !== false)
    );
    expect((screen.getByRole("button", { name: "Resend invitation" }) as HTMLButtonElement).disabled).toBe(
      !state.cloud && !state.ready
    );
  });
  it.each([false, true])("keeps safe native onboarding while config is loading (cloud=%s)", cloud => {
    state.cloud = cloud;
    state.loading = true;
    table();
    expect(!!screen.queryByRole("button", { name: "Invite member" })).toBe(cloud);
    expect(!!screen.queryByRole("button", { name: "Create user" })).toBe(!cloud);
  });
  it("allows local provisioning alongside existing-user invitations when signup is closed, with unchanged role grants", () => {
    state.disableSignup = true;
    table();
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    fireEvent.click(screen.getByRole("button", { name: "Invite member" }));
    expect(state.create).toHaveBeenCalledWith(["member"]);
    expect(state.invite).toHaveBeenCalledWith(["member"]);
  });
  it("offers native email invitations when configured and preserves assignable roles", () => {
    table();
    fireEvent.click(screen.getByRole("button", { name: "Invite member" }));
    expect(state.invite).toHaveBeenCalledWith(["member"]);
    expect((screen.getByRole("button", { name: "Resend invitation" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("retains local account creation when mail is unavailable", () => {
    state.ready = false;
    table();
    expect(screen.getByRole("button", { name: "Create user" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull();
    expect((screen.getByRole("button", { name: "Resend invitation" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("does not permit invitation management without member-management rights", () => {
    state.disableSignup = true;
    table(false);
    expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create user" })).toBeNull();
    expect((screen.getByRole("button", { name: "Resend invitation" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("does not resend an invitation whose role the caller cannot grant", () => {
    table(true, "owner");
    expect((screen.getByRole("button", { name: "Resend invitation" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
