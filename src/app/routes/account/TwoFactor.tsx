import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, KeyRound, ShieldCheck, ShieldAlert } from 'lucide-react';
import {
  confirmTotpEnrolment,
  disableTotp,
  regenerateRecoveryCodes,
  startTotpEnrolment,
  twoFactorStatus,
} from '../../../lib/api/twoFactor';
import { Button } from '../../../ui/Button';
import { Section } from '../../../ui/Card';
import { Field, TextInput } from '../../../ui/Form';
import { QrCode } from '../../../ui/QrCode';

/**
 * Two-step verification.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The shape of this screen is a sequence, not a settings panel, because turning on
 * a second factor is the one setting where a half-finished attempt locks you out of
 * your own account. So: password, then scan, then prove the scan worked, and only
 * then is it on. Nothing is saved as "enabled" until a code from the phone in your
 * hand has been accepted by the server.
 *
 * Two things this deliberately refuses to do:
 *
 *   - **It never lets you leave without the recovery codes.** They are shown once,
 *     because only their hashes are stored, and the confirm button says so. Losing
 *     both the phone and the codes means losing the workspace.
 *   - **It does not offer SMS as a fallback.** A fallback is as strong as its
 *     weakest branch, and SIM-swap is the attack this factor is supposed to stop.
 * ─────────────────────────────────────────────────────────────────────────────
 */

type Stage =
  | { kind: 'idle' }
  | { kind: 'password' }
  | { kind: 'scan'; secret: string; uri: string }
  | { kind: 'codes'; codes: string[] };

export function TwoFactorSection() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ['two-factor'], queryFn: twoFactorStatus });
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['two-factor'] });
    void client.invalidateQueries({ queryKey: ['me'] });
  };

  if (status.data?.enabled && stage.kind !== 'codes') {
    return (
      <Section
        title="Two-step verification"
        description="Your password alone is not enough to sign in to this account."
      >
        <div className="space-y-5">
          <p className="inline-flex items-center gap-2 rounded-full bg-green-50 px-3 py-1.5 text-sm font-semibold text-green-800">
            <ShieldCheck className="w-4 h-4" aria-hidden />
            On since {new Date(status.data.enrolled_at ?? Date.now()).toLocaleDateString()}
          </p>

          <RecoveryCodeCount
            left={status.data.recovery_codes_left}
            onRegenerated={(codes) => setStage({ kind: 'codes', codes })}
          />
          <DisablePanel onDone={refresh} />
        </div>
      </Section>
    );
  }

  return (
    <Section
      title="Two-step verification"
      description="A code from your phone, on top of your password. It is the difference between a leaked password costing you an afternoon and costing you your inbox."
    >
      {stage.kind === 'idle' && (
        <div className="space-y-4">
          <p className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1.5 text-sm font-semibold text-amber-800">
            <ShieldAlert className="w-4 h-4" aria-hidden />
            Off — a password is all anyone needs
          </p>
          <p className="text-sm text-gray-600 max-w-prose">
            You will need an authenticator app: 1Password, Google Authenticator, Authy,
            or the one built into your phone. Takes about a minute.
          </p>
          <Button onClick={() => setStage({ kind: 'password' })}>Turn it on</Button>
        </div>
      )}

      {stage.kind === 'password' && (
        <PasswordGate
          submitLabel="Continue"
          onCancel={() => setStage({ kind: 'idle' })}
          run={startTotpEnrolment}
          onDone={(result) => setStage({ kind: 'scan', secret: result.secret, uri: result.otpauth_uri })}
        />
      )}

      {stage.kind === 'scan' && (
        <ScanStep
          secret={stage.secret}
          uri={stage.uri}
          onCancel={() => setStage({ kind: 'idle' })}
          onDone={(codes) => {
            refresh();
            setStage({ kind: 'codes', codes });
          }}
        />
      )}

      {stage.kind === 'codes' && (
        <RecoveryCodes
          codes={stage.codes}
          onDone={() => {
            refresh();
            setStage({ kind: 'idle' });
          }}
        />
      )}
    </Section>
  );
}

/**
 * Re-enter the password before anything changes.
 *
 * Generic over what it unlocks, because the same barrier guards enrolling,
 * regenerating codes and turning the factor off — and a barrier reimplemented three
 * times is a barrier that ends up missing from one of them.
 */
function PasswordGate<T>({
  submitLabel,
  helper,
  extra,
  run,
  onDone,
  onCancel,
}: {
  submitLabel: string;
  helper?: string;
  /** Rendered between the password field and the buttons — the code, when one is needed. */
  extra?: React.ReactNode;
  run: (password: string) => Promise<T>;
  onDone: (result: T) => void;
  onCancel?: () => void;
}) {
  const [password, setPassword] = useState('');
  const call = useMutation({ mutationFn: () => run(password), onSuccess: onDone });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    call.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-4 max-w-sm">
      {helper && <p className="text-sm text-gray-600">{helper}</p>}
      {call.error && (
        <p role="alert" className="text-sm text-red-600">
          {(call.error as Error).message}
        </p>
      )}
      <Field label="Your password">
        {(a) => (
          <TextInput
            {...a}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </Field>
      {extra}
      <div className="flex gap-2">
        <Button type="submit" busy={call.isPending} disabled={!password}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="subtle" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function ScanStep({
  secret,
  uri,
  onDone,
  onCancel,
}: {
  secret: string;
  uri: string;
  onDone: (codes: string[]) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  const confirm = useMutation({
    mutationFn: () => confirmTotpEnrolment(code),
    onSuccess: (result) => onDone(result.recovery_codes),
  });

  return (
    /*
      Code beside the QR, not under it.

      The two are one action — scan, then type what it shows — and stacking them left
      a column of dead space next to the QR while pushing the input far enough down
      that the thing you are copying from is out of the same glance.
    */
    <div className="flex flex-col sm:flex-row gap-6 sm:items-start">
      {/*
        Drawn here, never fetched. A QR from a chart service would post the
        otpauth:// URI — which carries the secret itself — to a third party on every
        enrolment, which is the whole thing this factor exists to prevent.
      */}
      <QrCode value={uri} size={168} className="shrink-0 p-2 border border-gray-200" />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          confirm.mutate();
        }}
        className="min-w-0 flex-1 space-y-4"
      >
        <p className="text-sm text-gray-700">Scan this with your authenticator app.</p>
        {confirm.error && (
          <p role="alert" className="text-sm text-red-600">
            {(confirm.error as Error).message}
          </p>
        )}
        <Field label="Then enter the code it shows" hint="This proves the scan worked.">
          {(a) => (
            /*
              The width is on a wrapper around the input, not on the input and not
              around the whole field. Not on the input, because `TextInput` already
              carries `w-full` and a second width utility beside it is decided by
              stylesheet order rather than by what was written last. Not around the
              field, because that wraps the label onto two lines to constrain a box
              the label is not in.
            */
            <div className="max-w-[11rem]">
              <TextInput
                {...a}
                className="font-mono text-center tracking-[0.35em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </div>
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={confirm.isPending} disabled={code.length !== 6}>
            Turn on two-step verification
          </Button>
          <Button type="button" variant="subtle" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer select-none text-gray-500 hover:text-gray-800">
            Can’t scan it?
          </summary>
          <p className="mt-2 text-xs text-gray-500">Type this into the app instead:</p>
          <code className="mt-1 block rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-sm tracking-widest break-all">
            {secret.match(/.{1,4}/g)?.join(' ')}
          </code>
        </details>
      </form>
    </div>
  );
}

/**
 * The codes, shown once.
 *
 * "Once" is load-bearing: only hashes are stored, so this screen is the only place
 * they will ever exist. The confirmation checkbox is not ceremony — without it the
 * common path is closing the tab on a list you assumed you could find again.
 */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);

  const download = () => {
    const body =
      'Nestled recovery codes\n\n' +
      'Each of these works once, in place of your authenticator app.\n' +
      'Keep them somewhere other than the phone that holds the app.\n\n' +
      codes.join('\n') +
      '\n';
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nestled-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-900 flex items-start gap-2">
        <Check className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
        <span>Two-step verification is on. Now save these.</span>
      </div>
      <p className="text-sm text-gray-600 max-w-prose">
        Each code works <b>once</b>, in place of your app. They are the only way back
        into your account if you lose your phone — so keep them somewhere that is not
        that phone. <b>This is the only time they are shown.</b>
      </p>
      <ul className="grid grid-cols-2 gap-2 max-w-md font-mono text-sm">
        {codes.map((code) => (
          <li key={code} className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-center tracking-wider">
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={download}>
          <Download className="w-4 h-4" aria-hidden />
          Download them
        </Button>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300"
          />
          I have saved these somewhere safe
        </label>
      </div>
      <Button disabled={!saved} onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

function RecoveryCodeCount({
  left,
  onRegenerated,
}: {
  left: number;
  onRegenerated: (codes: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-2xl border border-gray-200 p-4 space-y-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-gray-800">
        <KeyRound className="w-4 h-4 text-gray-400" aria-hidden />
        Recovery codes
      </p>
      <p className={`text-sm ${left === 0 ? 'text-red-700 font-semibold' : 'text-gray-600'}`}>
        {left === 0
          ? 'None left. If you lose your phone now, you lose the account — generate a new set.'
          : `${left} unused ${left === 1 ? 'code' : 'codes'} left.`}
      </p>
      {open ? (
        <PasswordGate
          submitLabel="Generate a new set"
          helper="Generating replaces your current codes — the old ones stop working straight away."
          run={(password) => regenerateRecoveryCodes(password).then((r) => r.recovery_codes)}
          onDone={(codes) => {
            setOpen(false);
            onRegenerated(codes);
          }}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Generate a new set
        </Button>
      )}
    </div>
  );
}

/** Turning it off needs the password AND a factor — the same pair that would let someone in. */
function DisablePanel({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');

  if (!open) {
    return (
      <Button variant="danger" onClick={() => setOpen(true)}>
        Turn off two-step verification
      </Button>
    );
  }

  return (
    <div className="rounded-2xl border border-red-200 bg-red-50/50 p-4">
      <PasswordGate
        submitLabel="Turn it off"
        helper="Your password and a current code, so a stolen session cannot quietly remove this. A recovery code works too."
        extra={
          <Field label="Code from your app" hint="Or one of your recovery codes.">
            {(a) => (
              <TextInput
                {...a}
                className="font-mono tracking-widest"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </Field>
        }
        run={(password) =>
          disableTotp(
            // A recovery code carries a dash and letters; an app code is six digits.
            // Sending the right field means the server never has to guess, and a
            // mistyped app code cannot be silently tried as a recovery code.
            /^\d{6}$/.test(code.trim())
              ? { password, totp: code.trim() }
              : { password, recovery_code: code.trim() },
          )
        }
        onDone={() => {
          setOpen(false);
          setCode('');
          onDone();
        }}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
