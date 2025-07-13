import { PrivyClient } from '@privy-io/server-auth';
import { generateAuthorizationSignature } from '@privy-io/server-auth/wallet-api';

interface Env {
  PRIVY_APP_ID: string;
  PRIVY_APP_SECRET: string;
  PRIVY_AUTHORIZATION_KEY: string;
}

interface WebSocketState {
  walletId: string;
  authorizationKey: string;
}

const wsState = new Map<WebSocket, WebSocketState>();

// Helper function to convert base64url to hex (Cloudflare Workers compatible)
// Removed base64ToHex function - no longer needed with SPKI format

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
    
    // Log all incoming requests for debugging
    console.log('=== INCOMING REQUEST ===');
    console.log('Method:', request.method);
    console.log('URL:', request.url);
    console.log('Pathname:', url.pathname);
    console.log('Upgrade header:', request.headers.get('Upgrade'));
    console.log('=======================');
    
    // Handle WebSocket connections at /ws route
    if (url.pathname === '/ws' || url.pathname === '/ws/') {
      console.log('WebSocket route accessed');
      
      // Check for WebSocket upgrade immediately
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() !== 'websocket') {
        console.log('Invalid upgrade header:', upgradeHeader);
        return new Response('Expected websocket', { status: 400 });
      }

      const token = url.searchParams.get('token');
      if (!token) {
        console.log('No token provided');
        return new Response('Token required', { status: 401 });
      }

      // Create WebSocket pair and return immediately
      const pair = new WebSocketPair();
      const clientWs = pair[0];
      const serverWs = pair[1];

      serverWs.accept();
      console.log('WebSocket connection established!');

      // Handle authentication and setup asynchronously
      (async () => {
        try {
          console.log('Starting async authentication...');
          
          // Verify Privy token
          const client = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
          const verificationResult = await client.verifyAuthToken(token);
          console.log('Token verification successful for user:', verificationResult.userId);
          
          // Send welcome message
          serverWs.send(JSON.stringify({
            id: 'welcome',
            message: 'Connected to MCPrivy server! Authentication successful.',
            user: verificationResult.userId,
            jsonrpc: '2.0'
          }));

          // Use authorization key from environment
          console.log('Using authorization key from environment...');
          const authorizationKey = env.PRIVY_AUTHORIZATION_KEY;
          
          if (!authorizationKey) {
            throw new Error('PRIVY_AUTHORIZATION_KEY not found in environment');
          }
          
          console.log('Authorization key configured:', authorizationKey.substring(0, 20) + '...');

          // Check if user already has wallets
          console.log('Checking for existing wallets...');
          const userWalletsRes = await fetch(`https://api.privy.io/v1/users/${verificationResult.userId}/wallets`, {
            method: 'GET',
            headers: {
              'Authorization': `Basic ${btoa(env.PRIVY_APP_ID + ':' + env.PRIVY_APP_SECRET)}`,
              'privy-app-id': env.PRIVY_APP_ID,
            },
          });

          let walletId = 'temp-wallet-id';
          let walletAddress = 'temp-address';

          if (userWalletsRes.ok) {
            const walletsData = await userWalletsRes.json() as { wallets: Array<{ id: string; address: string; chain_type: string }> };
            
            // Find existing Ethereum wallet
            const existingWallet = walletsData.wallets.find(w => w.chain_type === 'ethereum');
            
            if (existingWallet) {
              walletId = existingWallet.id;
              walletAddress = existingWallet.address;
              console.log('Using existing wallet:', walletId, 'Address:', walletAddress);
              
              serverWs.send(JSON.stringify({
                id: 'wallet_found',
                result: { walletId, address: walletAddress, isNew: false },
                jsonrpc: '2.0'
              }));
            } else {
              // No existing wallet, create a new one
              console.log('No existing Ethereum wallet found, creating new wallet...');
              try {
                const createWalletRes = await fetch('https://api.privy.io/v1/wallets', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Basic ${btoa(env.PRIVY_APP_ID + ':' + env.PRIVY_APP_SECRET)}`,
                    'privy-app-id': env.PRIVY_APP_ID,
                    'Content-Type': 'application/json',
                  },
                                  body: JSON.stringify({
                  chain_type: 'ethereum',
                  owner: { user_id: verificationResult.userId },
                }),
                });

                if (createWalletRes.ok) {
                  const walletData = await createWalletRes.json() as { id: string; address: string };
                  walletId = walletData.id;
                  walletAddress = walletData.address;
                  console.log('New wallet created successfully:', walletId, 'Address:', walletAddress);

                  serverWs.send(JSON.stringify({
                    id: 'wallet_created',
                    result: { walletId, address: walletAddress, isNew: true },
                    jsonrpc: '2.0'
                  }));
                } else {
                  const errorText = await createWalletRes.text();
                  console.error('Wallet creation failed:', createWalletRes.status, errorText);
                  serverWs.send(JSON.stringify({
                    id: 'error',
                    error: `Wallet creation failed: ${errorText}`,
                    jsonrpc: '2.0'
                  }));
                }
              } catch (error) {
                console.error('Wallet creation error:', error);
                serverWs.send(JSON.stringify({
                  id: 'error',
                  error: `Wallet creation error: ${error}`,
                  jsonrpc: '2.0'
                }));
              }
            }
          } else {
            console.error('Failed to fetch user wallets:', userWalletsRes.status);
            // Fallback to creating new wallet
            try {
              const createWalletRes = await fetch('https://api.privy.io/v1/wallets', {
                method: 'POST',
                headers: {
                  'Authorization': `Basic ${btoa(env.PRIVY_APP_ID + ':' + env.PRIVY_APP_SECRET)}`,
                  'privy-app-id': env.PRIVY_APP_ID,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  chain_type: 'ethereum',
                  owner: { user_id: verificationResult.userId },
                }),
              });

              if (createWalletRes.ok) {
                const walletData = await createWalletRes.json() as { id: string; address: string };
                walletId = walletData.id;
                walletAddress = walletData.address;
                console.log('Fallback wallet created successfully:', walletId, 'Address:', walletAddress);

                serverWs.send(JSON.stringify({
                  id: 'wallet_created',
                  result: { walletId, address: walletAddress, isNew: true },
                  jsonrpc: '2.0'
                }));
              } else {
                const errorText = await createWalletRes.text();
                console.error('Fallback wallet creation failed:', createWalletRes.status, errorText);
                serverWs.send(JSON.stringify({
                  id: 'error',
                  error: `Wallet creation failed: ${errorText}`,
                  jsonrpc: '2.0'
                }));
              }
            } catch (error) {
              console.error('Fallback wallet creation error:', error);
              serverWs.send(JSON.stringify({
                id: 'error',
                error: `Wallet creation error: ${error}`,
                jsonrpc: '2.0'
              }));
            }
          }

          // Store wallet state
          wsState.set(serverWs, { walletId, authorizationKey });

        } catch (error) {
          console.error('Authentication error:', error);
          serverWs.send(JSON.stringify({
            id: 'error',
            error: `Authentication failed: ${error}`,
            jsonrpc: '2.0'
          }));
        }
      })();

      // Message handler
      serverWs.addEventListener('message', async (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string);
          console.log('Received message:', msg.method, 'with ID:', msg.id);
          
          const state = wsState.get(serverWs);
          if (!state) {
            serverWs.send(JSON.stringify({
              id: msg.id,
              error: 'WebSocket not properly initialized',
              jsonrpc: '2.0'
            }));
            return;
          }
          
          const { walletId, authorizationKey } = state;
          
          if (msg.method === 'signPersonalMessage') {
            const message = msg.params[0];
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
              authorizationPrivateKey: authorizationKey,
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
        console.log('WebSocket connection closed');
        wsState.delete(serverWs);
      });

      serverWs.addEventListener('error', (error: Event) => {
        console.error('WebSocket error:', error);
      });

      // Return the WebSocket response immediately
      return new Response(null, { status: 101, webSocket: clientWs });
    }

    // Handle health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        env: {
          PRIVY_APP_ID: !!env.PRIVY_APP_ID,
          PRIVY_APP_SECRET: !!env.PRIVY_APP_SECRET,
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Handle root route
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(`
        <!DOCTYPE html>
        <html>
          <head><title>MCPrivy Backend</title></head>
          <body>
            <h1>MCPrivy Backend Server</h1>
            <p>WebSocket endpoint: <code>/ws</code></p>
            <p>Health check: <code>/health</code></p>
            <p>Current path: <code>${url.pathname}</code></p>
          </body>
        </html>
      `, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    // Log unhandled routes for debugging
    console.log('Unhandled route:', url.pathname, 'Method:', request.method);

    // Handle other routes
    return new Response('Not found', { status: 404 });
  },
};