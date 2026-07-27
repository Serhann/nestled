import {
  Bot,
  Brush,
  Clock,
  Eye,
  Globe,
  Inbox,
  Lock,
  MessagesSquare,
  Route,
  Smartphone,
  Sparkles,
  Zap,
} from 'lucide-react';
import { Band, PrimaryCta, SectionHeading } from './Shell';

/**
 * What it does, in the reader's terms.
 *
 * The previous version of this page was a definition list of subsystems. This one
 * is organised by the moment you would need each thing — before the chat, during
 * it, and afterwards — because that is how somebody deciding whether to buy
 * actually thinks about it.
 */
export function Features() {
  return (
    <>
      <section className="bg-canvas">
        <div className="max-w-6xl mx-auto px-5 pt-16 pb-10 sm:pt-20 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-700">
            What it does
          </p>
          <h1 className="font-display text-4xl sm:text-5xl mt-3 text-balance">
            Everything you need to answer a customer
          </h1>
          <p className="mt-4 text-lg text-gray-600 max-w-2xl mx-auto">
            Grouped the way it happens: what your visitor sees, what your team sees while
            they reply, and what runs when nobody is at the keyboard.
          </p>
        </div>
      </section>

      <Group
        tone="cream"
        eyebrow="On your website"
        title="What your visitors see"
        lead="The bubble in the corner is the whole product as far as they are concerned, so it is the part we let you change most."
        items={[
          [
            Brush,
            'Make it yours',
            'Colour, corner style, font, which side it sits on, and your name and photo at the top. Everything is edited beside a live preview of the real widget, so nothing is a surprise once it is live.',
          ],
          [
            MessagesSquare,
            'Every word is yours to change',
            'The greeting, the placeholder, the message when you are closed, the rating prompt — all of it. Leave one alone and you get our wording, which keeps improving without you doing anything.',
          ],
          [
            Zap,
            'Start the conversation first',
            'Offer help after somebody has been reading your pricing for thirty seconds, or when they look like they are about to leave. Written by you, shown only where you want it.',
          ],
          [
            Clock,
            'Honest opening hours',
            'Set your week and your holidays. Outside them the chat says so and takes a message rather than showing a green dot with nobody behind it.',
          ],
          [
            Globe,
            'One account, several websites',
            'Each site gets its own chat, its own look and its own wording, and everything arrives in one inbox you can filter.',
          ],
          [
            Lock,
            'Trustworthy customer details',
            'If your own system can vouch for who somebody is, your team sees their details marked as verified — separately from anything the page merely claimed.',
          ],
        ]}
      />

      <Group
        eyebrow="While you reply"
        title="What your team sees"
        lead="Answering well is mostly about having the context already on screen instead of hunting for it."
        items={[
          [
            Inbox,
            'One shared inbox',
            'Filter by status, website, tag or whoever it is assigned to. Every filtered view is a link you can send a colleague, and it opens exactly what you were looking at.',
          ],
          [
            Eye,
            'Who is here right now',
            'A live list of visitors, the page each one is on, where they came from and roughly where they are. Say hello before they leave.',
          ],
          [
            MessagesSquare,
            'Saved replies and private notes',
            'Type a slash to drop in a reply you use constantly. Leave notes on a conversation that only your team can read.',
          ],
          [
            Smartphone,
            'On your phone, properly',
            'Install it to your home screen and get a notification when somebody writes. It will not notify the person already reading that conversation.',
          ],
          [
            Eye,
            'Watch a screen when words fail',
            'When somebody cannot describe what they are seeing, you can watch their page as they browse — only while you are actually watching, and only if you have switched it on.',
          ],
          [
            Route,
            'Send it to the right person',
            'Rules decide who picks up: take turns, give it to whoever has the fewest open chats, or always one person. Anyone offline is skipped and keeps their turn.',
          ],
        ]}
      />

      <Group
        tone="cream"
        eyebrow="When nobody is looking"
        title="What runs on its own"
        lead="The point is not to replace your team. It is that the fifteenth identical question of the day should not need one."
        items={[
          [
            Sparkles,
            'Answers from your own words',
            'Write your usual answers as plain sentences. The assistant replies from those and from verified customer details — and hands over instead of guessing about orders, prices or policies.',
          ],
          [
            Bot,
            'Guided conversations',
            'Build a flow that greets, asks a couple of questions and routes accordingly. Drag boxes, connect them, test it before it goes live, and roll back a version you did not like.',
          ],
          [
            Clock,
            'Nothing lost overnight',
            'Out of hours the chat collects a message and an email address, and it is at the top of your inbox in the morning.',
          ],
        ]}
      />

      <Band tone="ink">
        <div className="text-center max-w-2xl mx-auto">
          <h2 className="font-display text-3xl sm:text-4xl text-white text-balance">
            The best way to see it is to put it on your site
          </h2>
          <p className="mt-3 text-gray-300">
            Fourteen days with everything switched on. It takes a few minutes to set up, and
            you can be talking to a real visitor this afternoon.
          </p>
          <div className="mt-8">
            <PrimaryCta label="Start free for 14 days" />
          </div>
        </div>
      </Band>
    </>
  );
}

function Group({
  tone,
  eyebrow,
  title,
  lead,
  items,
}: {
  tone?: 'cream';
  eyebrow: string;
  title: string;
  lead: string;
  items: [typeof Inbox, string, string][];
}) {
  return (
    <Band tone={tone ?? 'canvas'}>
      <SectionHeading eyebrow={eyebrow} title={title} lead={lead} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(([Icon, name, body]) => (
          <div key={name} className="bg-white rounded-3xl border border-gray-100 p-6">
            <span className="w-10 h-10 rounded-2xl bg-blue-50 text-blue-700 flex items-center justify-center">
              <Icon className="w-5 h-5" aria-hidden />
            </span>
            <h3 className="mt-4 font-semibold text-gray-900">{name}</h3>
            <p className="mt-2 text-sm text-gray-600 leading-relaxed">{body}</p>
          </div>
        ))}
      </div>
    </Band>
  );
}
