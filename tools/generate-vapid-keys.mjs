import { generateKeyPairSync } from "node:crypto";

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  publicKeyEncoding: { format: "jwk" },
  privateKeyEncoding: { format: "jwk" }
});

const x = Buffer.from(publicKey.x, "base64url");
const y = Buffer.from(publicKey.y, "base64url");
const publicRaw = Buffer.concat([Buffer.from([0x04]), x, y]);

console.log("VAPID_PUBLIC_KEY=" + base64Url(publicRaw));
console.log("VAPID_PRIVATE_KEY=" + privateKey.d);
