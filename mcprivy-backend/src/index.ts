import { PrivyClient } from '@privy-io/server-auth';
import { generateAuthorizationSignature } from '@privy-io/server-auth/wallet-api';

interface Env {
  PRIVY_APP_ID: string;
  PRIVY_APP_SECRET: string;
}

interface WebSocketState {
  walletId: string;
  privateKeyHex: string;
}

const wsState = new Map<WebSocket, WebSocketState>();

// Helper function to convert base64 to hex (Cloudflare Workers compatible)
function base64ToHex(base64: string): string {
  const binary = atob(base64);
  let hex = '';
  for (let i = 0; i < binary.length; i++) {
    const byte = binary.charCodeAt(i);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// Helper function to convert ArrayBuffer to base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected websocket', { status: 400 });
      }

      const token = url.searchParams.get('token');
      if (!token) {
        return new Response('Token required', { status: 401 });
      }

      const client = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
      try {
        await client.verifyAuthToken(token);
      } catch (error) {
        return new Response('Invalid token', { status: 401 });
      }

      const pair = new WebSocketPair();
      const clientWs = pair[0];
      const serverWs = pair[1];

      serverWs.accept();

      // Generate session signer on connect
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
      ) as CryptoKeyPair;

      const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey) as JsonWebKey;
      const privateKeyHex = base64ToHex(privateJwk.d!);
      const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as JsonWebKey;
      const xHex = base64ToHex(publicJwk.x!).padStart(64, '0');
      const yHex = base64ToHex(publicJwk.y!).padStart(64, '0');
      const publicKeyHex = '04' + xHex + yHex;

      // Create wallet with this session signer as owner
      const createWalletRes = await fetch('https://api.privy.io/v1/wallets', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${btoa(env.PRIVY_APP_ID + ':' + env.PRIVY_APP_SECRET)}`,
          'privy-app-id': env.PRIVY_APP_ID,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chain_type: 'ethereum',
          owner: { public_key: publicKeyHex },
        }),
      });
      const walletData = await createWalletRes.json() as { id: string };
      const walletId = walletData.id;

      wsState.set(serverWs, { walletId, privateKeyHex });

      serverWs.addEventListener('message', async (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.method === 'signPersonalMessage') {
          const message = msg.params[0]; // Assume hex message

          const body = {
            method: 'personal_sign',
            params: {
              message,
              encoding: 'hex',
            },
          };

          const input = {
            method: 'POST' as const,
            url: `/v1/wallets/${walletId}/rpc`,
            headers: {
              'privy-app-id': env.PRIVY_APP_ID,
            },
            body,
            version: 1 as const,
          };

          const signature = generateAuthorizationSignature({
            input,
            authorizationPrivateKey: privateKeyHex,
          });

          const signRes = await fetch(`https://api.privy.io/v1/wallets/${walletId}/rpc`, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${btoa(env.PRIVY_APP_ID + ':' + env.PRIVY_APP_SECRET)}`,
              'privy-app-id': env.PRIVY_APP_ID,
              'Content-Type': 'application/json',
              'privy-authorization-signature': signature || '',
            },
            body: JSON.stringify(body),
          });
          const signData = await signRes.json() as { data: { signature: string } };

          serverWs.send(JSON.stringify({ id: msg.id, result: signData.data.signature, jsonrpc: '2.0' }));
        } else {
          serverWs.send(JSON.stringify({ id: msg.id, error: 'Unknown method', jsonrpc: '2.0' }));
        }
      });

      serverWs.addEventListener('close', () => wsState.delete(serverWs));

      return new Response(null, { status: 101, webSocket: clientWs });
    }

    return new Response('Not found', { status: 404 });
  },
};