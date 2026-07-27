/**
 * A picture of the product, drawn in HTML.
 *
 * A screenshot would be sharper, but it would also be a binary that goes stale
 * the first time anyone changes a corner radius, and it cannot be read by a
 * screen reader or scale on a phone. This is the actual widget's shape in
 * markup — prerendered, so it costs the visitor no JavaScript.
 */
export function WidgetMock() {
  return (
    <div className="relative mx-auto w-full max-w-sm" aria-hidden>
      <div className="rounded-3xl bg-white shadow-xl border border-gray-100 overflow-hidden">
        <div className="bg-blue-600 text-white px-4 py-3.5 flex items-center gap-3">
          <span className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-sm font-semibold">
            M
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight">Maya from Fern &amp; Fig</p>
            <p className="text-[11px] text-white/80 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-300" />
              Usually replies in a few minutes
            </p>
          </div>
        </div>

        <div className="p-4 space-y-3 bg-canvas/40">
          <Bubble from="them">Hi! Anything I can help you find?</Bubble>
          <Bubble from="you">do you ship to Ireland, and how long does it take?</Bubble>
          <Bubble from="them">
            We do — Ireland is 3–5 working days, and it&rsquo;s free over €60. Your basket is at
            €72, so you&rsquo;re covered.
          </Bubble>
          <Bubble from="you">perfect, thanks</Bubble>
        </div>

        <div className="border-t border-gray-100 px-4 py-3 flex items-center gap-2">
          <span className="flex-1 text-sm text-gray-400">Write a message…</span>
          <span className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs">
            ↑
          </span>
        </div>
      </div>

      <p className="mt-4 text-center text-xs text-gray-500">
        Your colours, your wording, your name on it.
      </p>
    </div>
  );
}

function Bubble({ from, children }: { from: 'you' | 'them'; children: React.ReactNode }) {
  const mine = from === 'you';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <p
        className={`max-w-[85%] text-sm px-3.5 py-2.5 shadow-sm ${
          mine
            ? 'bg-gray-800 text-white rounded-2xl rounded-br-md'
            : 'bg-white text-gray-800 border border-gray-100 rounded-2xl rounded-bl-md'
        }`}
      >
        {children}
      </p>
    </div>
  );
}
