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

// Helper function to convert base64url to hex (Cloudflare Workers compatible)
function base64ToHex(base64url: string): string {
  // Convert URL-safe base64 to regular base64
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if needed
  while (base64.length % 4) {
    base64 += '=';
  }
  
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
    
    // Handle WebSocket connections at /ws route
    if (url.pathname === '/ws') {
      try {
        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader !== 'websocket') {
          return new Response('Expected websocket', { status: 400 });
        }

        const token = url.searchParams.get('token');
        if (!token) {
          return new Response('Token required', { status: 401 });
        }

        console.log('Received token, verifying...');
        
        // Verify Privy token
        const client = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
        
        let verificationResult;
        try {
          verificationResult = await client.verifyAuthToken(token);
          console.log('Token verification successful for user:', verificationResult.userId);
        } catch (error) {
          console.error('Token verification error:', error);
          return new Response('Invalid token', { status: 401 });
        }

        console.log('Creating WebSocket pair...');
        const pair = new WebSocketPair();
        const clientWs = pair[0];
        const serverWs = pair[1];

        serverWs.accept();
        console.log('WebSocket connection established!');
        
        // Send a welcome message
        serverWs.send(JSON.stringify({
          id: 'welcome',
          message: 'Connected to MCPrivy server! Full functionality enabled.',
          user: verificationResult.userId,
          jsonrpc: '2.0'
        }));

        console.log('Generating session signer...');
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

        console.log('Creating wallet with session signer...');
        // Create wallet with this session signer as owner
        let createWalletRes;
        try {
          createWalletRes = await fetch('https://api.privy.io/v1/wallets', {
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
        } catch (fetchError) {
          console.error('Wallet creation fetch error:', fetchError);
          serverWs.send(JSON.stringify({
            id: 'error',
            error: `Wallet creation fetch failed: ${fetchError}`,
            jsonrpc: '2.0'
          }));
          // Don't return error, continue with WebSocket
        }

        if (createWalletRes && !createWalletRes.ok) {
          const errorText = await createWalletRes.text();
          console.error('Wallet creation failed:', createWalletRes.status, errorText);
          serverWs.send(JSON.stringify({
            id: 'error',
            error: `Wallet creation failed: ${errorText}`,
            jsonrpc: '2.0'
          }));
          // Don't return error, continue with WebSocket
        }

        let walletId = 'temp-wallet-id';
        let walletAddress = 'temp-address';
        
        if (createWalletRes && createWalletRes.ok) {
          try {
            const walletData = await createWalletRes.json() as { id: string; address: string };
            walletId = walletData.id;
            walletAddress = walletData.address;
            console.log('Wallet created successfully:', walletId, 'Address:', walletAddress);

            // Send wallet info to client
            serverWs.send(JSON.stringify({
              id: 'wallet_created',
              result: { 
                walletId,
                address: walletAddress
              },
              jsonrpc: '2.0'
            }));
          } catch (parseError) {
            console.error('Error parsing wallet response:', parseError);
            serverWs.send(JSON.stringify({
              id: 'error',
              error: `Error parsing wallet response: ${parseError}`,
              jsonrpc: '2.0'
            }));
          }
        }

        wsState.set(serverWs, { walletId, privateKeyHex });

        serverWs.addEventListener('message', async (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            console.log('Received message:', msg.method, 'with ID:', msg.id);
            
            if (msg.method === 'signPersonalMessage') {
              const message = msg.params[0]; // Assume hex message
              console.log('Signing message:', message);

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
              
              if (!signRes.ok) {
                const errorText = await signRes.text();
                console.error('Sign request failed:', signRes.status, errorText);
                serverWs.send(JSON.stringify({ 
                  id: msg.id, 
                  error: `Sign failed (${signRes.status}): ${errorText}`, 
                  jsonrpc: '2.0' 
                }));
                return;
              }
              
              const signData = await signRes.json() as { data: { signature: string } };
              console.log('Sign successful! Signature:', signData.data.signature);

              serverWs.send(JSON.stringify({ 
                id: msg.id, 
                result: signData.data.signature, 
                jsonrpc: '2.0' 
              }));
            } else {
              console.log('Unknown method:', msg.method);
              serverWs.send(JSON.stringify({ 
                id: msg.id, 
                error: `Unknown method: ${msg.method}`, 
                jsonrpc: '2.0' 
              }));
            }
          } catch (error) {
            console.error('Message handling error:', error);
            serverWs.send(JSON.stringify({ 
              id: 1, 
              error: `Internal server error: ${error}`, 
              jsonrpc: '2.0' 
            }));
          }
        });

        serverWs.addEventListener('close', () => {
          console.log('WebSocket connection closed for wallet:', walletId);
          wsState.delete(serverWs);
        });

        serverWs.addEventListener('error', (error) => {
          console.error('WebSocket error:', error);
        });

        return new Response(null, { status: 101, webSocket: clientWs });
      } catch (error) {
        console.error('WebSocket setup error:', error);
        return new Response(`Internal server error: ${error}`, { status: 500 });
      }
    }

    // Handle other routes - let the static assets be served
    return new Response('Not found', { status: 404 });
  },
};