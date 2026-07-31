import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dateTime } from '../api';
import { useSession } from '../session';
import type { StaffAccount, StaffListResponse } from '../types';
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, Spinner, Table, Td, inputClass } from '../ui';

/**
 * Staff accounts, their roles, and the scopes on top.
 *
 * The role is a bundle and the checkboxes are the adjustment, which is the whole point
 * of the model: "this support lead may also close accounts" used to mean promoting them
 * to superadmin, and that granted them everything.
 *
 * Two things this screen has to make visible, or the model is worse than four roles:
 *
 *   - which ticks come from the ROLE and which were added for this person. A flat list
 *     of fourteen ticks tells you nothing about what changing the role would do.
 *   - that a **denied** scope wins over the role, including over superadmin. That is the
 *     only way to say "administers the install but does not read customer
 *     conversations", and it is invisible unless the UI says so.
 *
 * The vocabulary comes from the server (`catalog`) rather than a list in this file, so a
 * scope added in a release appears here without a frontend change.
 */

/** What each scope means, in the language of consequences rather than routes. */
const DESCRIPTIONS: Record<string, string> = {
  'panel:read': 'See everything in this panel: customers, conversations metadata, audit, health.',
  'note:write': 'Leave staff notes on a customer.',
  'workspace:lifecycle': 'Extend trials, grant grace, change status, cancel a scheduled purge.',
  'workspace:plan': 'Set one customer’s plan, their billing mode, or a private plan override.',
  'plan:write': 'Change the plan catalog — what every customer can be sold.',
  'user:confirm_email': 'Confirm a customer’s email address without them clicking a link.',
  'deletion:create': 'Delete a workspace, website, user or conversation.',
  'deletion:restore': 'Undo a deletion inside the 90-day window.',
  'impersonate:read_only': 'Sign in as a customer to look.',
  'impersonate:full': 'Sign in as a customer and act as them.',
  'impersonate:end': 'End somebody else’s impersonation session.',
  'settings:write': 'Install-wide settings: AI keys, SMTP, Stripe, retention.',
  'ai:prompt': 'Rewrite one website’s assistant instructions — including when it hands off.',
  'staff:manage': 'Create staff accounts and change their roles and permissions.',
};

export function Staff() {
  const session = useSession();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<StaffAccount | null>(null);

  const { data, error, isPending } = useQuery({
    queryKey: ['staff'],
    queryFn: () => api<StaffListResponse>('/platform/users'),
  });

  const canManage = session?.user.capabilities?.includes('staff:manage') ?? false;

  return (
    <div className="space-y-3">
      <Card
        title="Staff accounts"
        action={
          <Button
            variant="primary"
            disabled={!canManage || !session?.user.can_write}
            title={
              !canManage
                ? 'Needs the staff:manage permission'
                : session?.user.can_write
                  ? undefined
                  : 'Enroll an authenticator first'
            }
            onClick={() => setCreating(true)}
          >
            Add an account
          </Button>
        }
      >
        <p className="mb-3 text-xs text-gray-500">
          A new account starts read-only until it enrols an authenticator, and is asked to change the
          password you set for it — until it does, every audit row it writes is one you could also
          have written.
        </p>

        {error && <ErrorBox error={error} />}
        {isPending && <Spinner />}
        {data && data.users.length === 0 && <Empty>No staff accounts.</Empty>}

        {data && data.users.length > 0 && (
          <Table head={['Who', 'Role', 'Permissions', 'Factor', 'Sessions', 'Added', '']}>
            {data.users.map((user) => (
              <tr key={user.id} className={user.disabled_at ? 'opacity-50' : ''}>
                <Td>
                  {user.name}
                  <span className="block text-xs text-gray-500">{user.email}</span>
                </Td>
                <Td>
                  <Badge tone={user.role === 'superadmin' ? 'warn' : 'neutral'}>{user.role}</Badge>
                  {user.disabled_at && <Badge tone="fail">disabled</Badge>}
                </Td>
                <Td className="text-xs text-gray-400">
                  {/*
                    Only the DIFFERENCE from the role is worth a row here. Printing all
                    fourteen for every account buries the one line that matters.
                  */}
                  {user.granted_scopes.length === 0 && user.denied_scopes.length === 0 ? (
                    <span className="text-gray-500">role defaults</span>
                  ) : (
                    <>
                      {user.granted_scopes.length > 0 && (
                        <span className="block text-green-300">+ {user.granted_scopes.join(', ')}</span>
                      )}
                      {user.denied_scopes.length > 0 && (
                        <span className="block text-red-300">− {user.denied_scopes.join(', ')}</span>
                      )}
                    </>
                  )}
                </Td>
                <Td>
                  {user.totp_enabled ? (
                    <Badge tone="ok">enrolled</Badge>
                  ) : (
                    <Badge tone="warn">read-only</Badge>
                  )}
                  {user.must_change_password && (
                    <span className="block text-xs text-amber-300">password not changed yet</span>
                  )}
                </Td>
                <Td className="text-gray-400">{user._count.sessions}</Td>
                <Td className="text-gray-400">{dateTime(user.created_at)}</Td>
                <Td>
                  <Button
                    disabled={!canManage || !session?.user.can_write}
                    onClick={() => setEditing(user)}
                  >
                    Edit
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {creating && data && (
        <StaffDialog catalog={data.catalog} onClose={() => setCreating(false)} />
      )}
      {editing && data && (
        <StaffDialog catalog={data.catalog} account={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

type Catalog = StaffListResponse['catalog'];

/**
 * Create or edit. One dialog, because the interesting half — the permission matrix — is
 * identical, and two copies of it would drift.
 */
function StaffDialog({
  catalog,
  account,
  onClose,
}: {
  catalog: Catalog;
  account?: StaffAccount;
  onClose: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const editing = account !== undefined;

  const [email, setEmail] = useState(account?.email ?? '');
  const [name, setName] = useState(account?.name ?? '');
  const [role, setRole] = useState(account?.role ?? 'support');
  const [password, setPassword] = useState('');
  const [granted, setGranted] = useState<string[]>(account?.granted_scopes ?? []);
  const [denied, setDenied] = useState<string[]>(account?.denied_scopes ?? []);
  const [disabled, setDisabled] = useState(Boolean(account?.disabled_at));

  const roleScopes = useMemo(() => new Set(catalog.by_role[role] ?? []), [catalog, role]);
  const mine = useMemo(() => new Set(session?.user.capabilities ?? []), [session]);
  const isSelf = account?.id === session?.user.id;

  /** What this account would end up with. Same rule as the server's. */
  const effective = useMemo(() => {
    const out = new Set(roleScopes);
    for (const scope of granted) out.add(scope);
    for (const scope of denied) out.delete(scope);
    return out;
  }, [roleScopes, granted, denied]);

  /** Scopes the editor does not hold, so the server would refuse the whole edit. */
  const cannotGrant = [...effective].filter((scope) => !mine.has(scope));

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api(`/platform/users/${account.id}`, {
            method: 'PATCH',
            body: {
              name,
              role,
              disabled,
              ...(isSelf ? {} : { granted_scopes: granted, denied_scopes: denied }),
            },
          })
        : api('/platform/users', {
            method: 'POST',
            body: { email, name, password, role, granted_scopes: granted, denied_scopes: denied },
          }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
      onClose();
    },
  });

  function toggle(scope: string) {
    const fromRole = roleScopes.has(scope);
    const isGranted = granted.includes(scope);
    const isDenied = denied.includes(scope);

    // One checkbox, three states, because that is what the data means: a scope is
    // either at its role default, added, or taken away. Clicking cycles to the state a
    // person actually wants — the opposite of whatever it is now.
    if (fromRole) {
      setDenied(isDenied ? denied.filter((s) => s !== scope) : [...denied, scope]);
      setGranted(granted.filter((s) => s !== scope));
    } else {
      setGranted(isGranted ? granted.filter((s) => s !== scope) : [...granted, scope]);
      setDenied(denied.filter((s) => s !== scope));
    }
  }

  const ready = editing
    ? name.trim().length > 0
    : email.trim().length > 3 && name.trim().length > 0 && password.length >= 12;

  return (
    <Modal title={editing ? `Edit ${account.email}` : 'Add a staff account'} onClose={onClose}>
      {save.error && <ErrorBox error={save.error} />}

      <div className="space-y-3">
        {!editing && (
          <>
            <Field label="Email">
              <input value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
            </Field>
            <Field
              label="Initial password"
              hint="At least 12 characters. They are asked to change it, and until they do you know their credential."
            >
              <div className="flex gap-2">
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass}
                />
                <Button onClick={() => setPassword(generatePassword())}>Generate</Button>
              </div>
            </Field>
          </>
        )}

        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>

        <Field label="Role" hint="A named bundle of the permissions below.">
          <select value={role} onChange={(e) => setRole(e.target.value)} className={inputClass}>
            {catalog.roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>

        {editing && !isSelf && (
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
            Disabled — signs them out and refuses new sessions
          </label>
        )}

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Permissions</p>
          {isSelf ? (
            <p className="mt-1 text-xs text-amber-300">
              You cannot change your own permissions — in either direction. Another account with
              staff:manage does it, which is also what leaves a second name on the record.
            </p>
          ) : (
            <p className="mt-1 text-xs text-gray-500">
              Ticked scopes come from the role unless marked. Clicking one either adds it or takes it
              away; taking one away wins over the role, superadmin included.
            </p>
          )}

          <div className="mt-2 space-y-1.5">
            {catalog.capabilities.map((scope) => {
              const fromRole = roleScopes.has(scope);
              const isGranted = granted.includes(scope);
              const isDenied = denied.includes(scope);
              const on = effective.has(scope);
              const unavailable = !mine.has(scope);
              return (
                <label
                  key={scope}
                  className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs ${
                    isDenied ? 'bg-red-500/10' : isGranted ? 'bg-green-500/10' : ''
                  } ${unavailable ? 'opacity-60' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={isSelf || unavailable}
                    onChange={() => toggle(scope)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-mono text-gray-200">{scope}</span>
                    {isGranted && <span className="ml-2 text-green-300">added</span>}
                    {isDenied && <span className="ml-2 text-red-300">removed</span>}
                    {!fromRole && !isGranted && !isDenied && (
                      <span className="ml-2 text-gray-500">not in {role}</span>
                    )}
                    {unavailable && <span className="ml-2 text-amber-300">you do not have this</span>}
                    <span className="block text-gray-500">{DESCRIPTIONS[scope] ?? scope}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {cannotGrant.length > 0 && (
          /*
            Shown before the button is pressed rather than as a 403 afterwards. The
            server refuses this too — you cannot hand out what you do not hold, or
            staff:manage would be a path to every other scope.
          */
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            This would give the account permissions you do not have yourself
            ({cannotGrant.join(', ')}), which will be refused. Ask somebody who has them.
          </p>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={save.isPending || !ready || cannotGrant.length > 0}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : editing ? 'Save' : 'Create'}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * A password worth handing over once.
 *
 * `crypto.getRandomValues` rather than Math.random: this value protects every customer
 * in the install until its owner changes it, and a predictable one is worse than a short
 * one. The alphabet excludes the characters people misread when copying by hand.
 */
function generatePassword(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((n) => alphabet[n % alphabet.length]).join('');
}
