import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { createWorkspace } from '../../../lib/api/workspace';
import { slugAvailable } from '../../../lib/api/auth';
import { qk } from '../../../lib/queryKeys';
import { Button } from '../../../ui/Button';
import { Field, TextInput, Select } from '../../../ui/Form';
import { AuthLayout, FormError } from '../auth/AuthLayout';

/**
 * Step two of the wizard: name the workspace.
 *
 * The address is checked as it is typed rather than on submit. Discovering the
 * name you chose is taken *after* pressing the button, and having to invent
 * another one on the spot, is a small humiliation at exactly the wrong moment.
 */
export default function CreateWorkspace() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [touchedSlug, setTouchedSlug] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [timezone, setTimezone] = useState(
    // The browser already knows; asking is a question with a right answer we can
    // simply fill in.
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const effectiveSlug = touchedSlug ? slug : slugify(name);

  useEffect(() => {
    if (effectiveSlug.length < 3) {
      setAvailable(null);
      return;
    }
    const handle = setTimeout(() => {
      slugAvailable(effectiveSlug)
        .then((r) => setAvailable(r.available))
        .catch(() => setAvailable(null));
    }, 350);
    return () => clearTimeout(handle);
  }, [effectiveSlug]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { workspace } = await createWorkspace({ name, slug: effectiveSlug, timezone });
      await queryClient.invalidateQueries({ queryKey: qk.me() });
      navigate(`/w/${workspace.slug}/setup`, { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Name your workspace" subtitle="You can change this later.">
      <form onSubmit={submit} className="space-y-4">
        <FormError error={error} />
        <Field label="Company or team name" required>
          {(a) => (
            <TextInput
              {...a}
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
            />
          )}
        </Field>
        <Field
          label="Address"
          hint={
            available === false
              ? undefined
              : `app.nestled.chat/w/${effectiveSlug || 'your-team'}`
          }
          error={available === false ? 'That address is taken.' : null}
        >
          {(a) => (
            <TextInput
              {...a}
              value={effectiveSlug}
              onChange={(e) => {
                setTouchedSlug(true);
                setSlug(slugify(e.target.value));
              }}
              placeholder="acme"
            />
          )}
        </Field>
        <Field label="Time zone" hint="Used for business hours and reports.">
          {(a) => (
            <Select {...a} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {timezoneOptions(timezone).map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" busy={busy} disabled={available === false} className="w-full">
          Continue
        </Button>
      </form>
    </AuthLayout>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * The full IANA list where the browser exposes it, and the detected zone alone
 * where it does not — a hardcoded shortlist would be wrong for most of the world.
 */
function timezoneOptions(current: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
    .supportedValuesOf;
  const all = supported ? supported('timeZone') : [current];
  return all.includes(current) ? all : [current, ...all];
}
