/**
 * Print a VAPID key pair for .env:  node scripts/gen-vapid.mjs
 * Uses node:crypto only — copy the two lines into VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.
 */
import crypto from 'node:crypto';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const pub = crypto.createPublicKey(publicKey).export({ format: 'jwk' });
const priv = crypto.createPrivateKey(privateKey).export({ format: 'jwk', privateKey: true });
const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);

console.log(`VAPID_PUBLIC_KEY=${point.toString('base64url')}`);
console.log(`VAPID_PRIVATE_KEY=${Buffer.from(priv.d, 'base64url').toString('base64url')}`);
console.log('# also set VAPID_SUBJECT=mailto:you@example.com (push services require contact details)');
