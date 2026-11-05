import Link from "next/link";
import { listAdminUsers, userQuerySchema } from "@/lib/admin/control-center";
import { requireSuperAdminPage, singleParams } from "@/lib/admin/page-access";
import UserAdminActions from "@/components/admin/UserAdminActions";
import {
  Badge,
  EmptyRow,
  FilterActions,
  FilterBar,
  FilterField,
  PageTitle,
  Pagination,
  SearchField,
  TableCard,
  Td,
  Th,
  Tr,
  formatDate,
  inputClass,
  linkClass,
} from "@/components/admin/ControlCenterUI";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireSuperAdminPage();
  const query = userQuerySchema.parse(singleParams(await searchParams));
  const result = await listAdminUsers(query);
  const current = { q: query.q, role: query.role, state: query.state };

  return (
    <div className="space-y-5">
      <PageTitle
        title="Platform users"
        description="Platform role (user / super admin) is separate from business roles (owner / manager / staff), which grant no platform rights and are never changed here. Every account action signs the user out everywhere and is recorded in the audit log. You cannot change your own account, and the last active super admin cannot be removed."
      />
      <FilterBar className="sm:grid-cols-2 lg:grid-cols-4">
        <SearchField label="Search" name="q" defaultValue={query.q ?? ""} maxLength={100} placeholder="Name or email" className="sm:col-span-2" />
        <FilterField label="Platform role">
          <select name="role" defaultValue={query.role ?? ""} className={inputClass}>
            <option value="">Any</option>
            <option value="user">User</option>
            <option value="super_admin">Super admin</option>
          </select>
        </FilterField>
        <FilterField label="Account state">
          <select name="state" defaultValue={query.state ?? ""} className={inputClass}>
            <option value="">Any</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="unverified">Email unverified</option>
          </select>
        </FilterField>
        <FilterActions resetHref="/admin/users" className="sm:col-span-2 lg:col-span-4" />
      </FilterBar>

      <TableCard
        label="Platform users"
        minWidth="min-w-[980px]"
        head={
          <>
            <Th>User</Th>
            <Th>Platform role</Th>
            <Th>State</Th>
            <Th>Email</Th>
            <Th>Business memberships</Th>
            <Th>Joined</Th>
            <Th>Actions</Th>
          </>
        }
      >
        {result.users.length === 0 && (
          <EmptyRow colSpan={7} title="No users match these filters.">Try a different search, or reset the filters.</EmptyRow>
        )}
        {result.users.map((u) => (
          <Tr key={u.id}>
            <Td>
              <span className="font-medium text-slate-900">{u.name}</span>
              <span className="block text-xs text-slate-500">{u.email}</span>
            </Td>
            <Td><Badge value={u.platformRole} /></Td>
            <Td><Badge value={u.active ? "active" : "inactive"} /></Td>
            <Td>
              <Badge value={u.emailVerification} label={u.emailVerification === "legacy" ? "legacy (treated as verified)" : u.emailVerification} />
            </Td>
            <Td>
              {u.memberships.length === 0 ? <span className="text-slate-500">None</span> : (
                <ul className="space-y-0.5">
                  {u.memberships.map((m) => (
                    <li key={`${m.businessId}-${m.role}`}>
                      <Link href={`/admin/businesses/${m.businessId}`} className={linkClass}>{m.businessName || m.businessId}</Link>{" "}
                      <span className="text-xs text-slate-500">{m.role}{m.status !== "active" ? ` (${m.status})` : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Td>
            <Td className="whitespace-nowrap text-slate-500">{formatDate(u.createdAt)}</Td>
            <Td>
              <UserAdminActions user={{ id: u.id, name: u.name, platformRole: u.platformRole, active: u.active }} isSelf={u.id === String(me._id)} />
            </Td>
          </Tr>
        ))}
      </TableCard>
      <Pagination path="/admin/users" params={current} page={result.page} pageSize={result.pageSize} total={result.total} />
    </div>
  );
}
