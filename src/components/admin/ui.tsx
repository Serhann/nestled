import { ArrowLeft, type LucideIcon } from 'lucide-react';

/**
 * Shared Organic-design building blocks for the admin "Manage" screens
 * (Agents, Knowledge base, Canned responses, Triggers, Settings & AI). Keeps
 * every management page on the same warm palette + rounded card language the
 * Dashboard uses, without repeating the markup five times.
 */

/** Scrollable page shell on the warm canvas, centred to a comfortable width. */
export function ManagePage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto bg-canvas">
      <div className="max-w-4xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6">{children}</div>
    </div>
  );
}

/** Big Caprasimo title + subtitle, optional back button and right-side action. */
export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  onBack,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  onBack?: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      {onBack && (
        <button
          onClick={onBack}
          aria-label="Back"
          className="mt-1 shrink-0 w-9 h-9 rounded-full bg-white border border-gray-100 shadow-sm flex items-center justify-center text-gray-500 hover:text-gray-800 hover:shadow transition"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          {Icon && (
            <span className="w-9 h-9 rounded-2xl bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
              <Icon className="w-5 h-5" />
            </span>
          )}
          <h1 className="font-display text-3xl sm:text-[2rem] leading-none text-gray-800 truncate">{title}</h1>
        </div>
        {subtitle && <p className="text-sm text-gray-500 mt-1.5">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

/** White rounded card. */
export function Card({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={`bg-white rounded-3xl shadow-sm border border-gray-100/80 ${className}`}>{children}</div>
  );
}

/** Terracotta pill button. */
export function PrimaryButton({
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 bg-blue-600 text-white rounded-full px-5 py-2.5 text-sm font-semibold shadow-sm hover:bg-blue-700 active:scale-[.98] disabled:opacity-60 disabled:pointer-events-none transition ${className}`}
    >
      {children}
    </button>
  );
}

/** Neutral pill button (cancel / secondary). */
export function GhostButton({
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 bg-white text-gray-600 border border-gray-200 rounded-full px-5 py-2.5 text-sm font-semibold hover:bg-gray-50 active:scale-[.98] transition ${className}`}
    >
      {children}
    </button>
  );
}

/** Empty-state block with a soft icon badge. */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Card className="p-10 flex flex-col items-center text-center">
      <span className="w-14 h-14 rounded-3xl bg-blue-50 text-blue-600 flex items-center justify-center mb-4">
        <Icon className="w-7 h-7" />
      </span>
      <p className="font-semibold text-gray-800">{title}</p>
      {hint && <p className="text-sm text-gray-500 mt-1 max-w-sm">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </Card>
  );
}

export const fieldClass =
  'w-full px-3.5 py-2.5 bg-white border border-gray-200 rounded-xl text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400 transition';

/** Labelled field wrapper. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold text-gray-700 mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-xs text-gray-400 mt-1">{hint}</span>}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${fieldClass} ${props.className ?? ''}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${fieldClass} resize-y ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${fieldClass} appearance-none ${props.className ?? ''}`} />;
}

/** iOS-style toggle switch with an optional label + description row. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  description?: string;
}) {
  const knob = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-300'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`}
      />
    </button>
  );
  if (!label) return knob;
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-800">{label}</p>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
      </div>
      {knob}
    </div>
  );
}

/** Small rounded status/role pill. */
export function Badge({
  children,
  tone = 'gray',
}: {
  children: React.ReactNode;
  tone?: 'gray' | 'blue' | 'green' | 'amber' | 'red';
}) {
  const tones: Record<string, string> = {
    gray: 'bg-gray-100 text-gray-600',
    blue: 'bg-blue-100 text-blue-700',
    green: 'bg-green-100 text-green-700',
    amber: 'bg-amber-100 text-amber-700',
    red: 'bg-red-100 text-red-600',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Centered modal dialog on a dimmed backdrop. */
export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-gray-900/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-cream rounded-t-3xl sm:rounded-3xl shadow-xl border border-gray-100 max-h-[92dvh] flex flex-col animate-pop-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-3 shrink-0">
          <h2 className="font-display text-2xl text-gray-800">{title}</h2>
        </div>
        <div className="px-5 overflow-y-auto flex-1">{children}</div>
        {footer && <div className="px-5 py-4 shrink-0 flex gap-2 justify-end">{footer}</div>}
      </div>
    </div>
  );
}
