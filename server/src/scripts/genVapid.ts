import webpush from 'web-push';

/**
 * Print a fresh VAPID key pair for the .env. Run once per deployment:
 *   npm run vapid
 * Then copy the two lines into your .env (or the compose env).
 */
const keys = webpush.generateVAPIDKeys();
// eslint-disable-next-line no-console
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
// eslint-disable-next-line no-console
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
