/**
 * The landing page's questions and answers — ONE source, read twice.
 *
 * `Home.tsx` renders these as the visible FAQ; `seo.ts` turns the same array into FAQPage
 * structured data. That sharing is not tidiness, it is the requirement: Google's structured
 * data policy is that FAQPage markup must match content visible on the page, and a copy that
 * drifted would be a manual action rather than a rich result. Two arrays would drift the
 * first time somebody reworded an answer.
 */

/** A question and its answer, in that order. */
export type FaqEntry = [question: string, answer: string];

export const FAQS: FaqEntry[] = [
  [
    'Do I need a developer to set it up?',
    'Almost certainly not. You copy a short piece of code and paste it into your site — we give you step-by-step instructions for Shopify, WordPress, Webflow, Squarespace, Google Tag Manager and plain HTML. While you do it, the setup screen watches for your site and tells you the second it appears. If it lands somewhere unexpected we say so and offer to fix it in one click.',
  ],
  [
    'What happens when nobody is online?',
    'You decide. The chat can take a message and an email address, quietly collect a message without asking for one, hand over to an automated flow, or hide itself entirely. Whatever you pick, it stops pretending somebody is there — a green dot with nobody behind it does more damage than being closed.',
  ],
  [
    'What if the assistant gets something wrong?',
    'It is built to hand over rather than guess: anything about an order, an account, a price or a policy it was not given goes to a person, and you get notified. You can also turn it off completely and answer everything yourself, or let it speak only when nobody is around.',
  ],
  [
    'Can I make it match my brand?',
    'Yes — colour, corner style, font, which side it sits on, your name and photo at the top, and every single word a visitor reads. You edit it next to a live preview of the real widget, so what you see is what your customers get.',
  ],
  [
    'Can I use it on more than one website?',
    'Yes. Each website gets its own chat, its own settings and its own wording, and they all arrive in the same inbox where you can filter by site. Your plan sets how many.',
  ],
  [
    'What if I go over my plan in a busy month?',
    'Your chat keeps working. We will tell you, and you can move up a plan, but we will not switch off a live website in the middle of your best week. That decision is deliberate.',
  ],
  [
    'Who can see my conversations?',
    'Your team, according to the permissions you set — you can limit somebody to one website, or to answering chats without touching settings. Our own staff can only enter your account through a recorded, time-limited session that appears in your activity log, and even then cannot touch your billing or your integration keys.',
  ],
  [
    'How do I cancel?',
    'From the billing page, whenever you like. It runs to the end of the period you paid for. We keep your data for thirty days after that in case you come back, then delete it.',
  ],
];
