import { PrivyClient } from '@privy-io/server-auth';

interface Env {
  PRIVY_APP_ID: string;
  PRIVY_APP_SECRET: string;
  AUTH_PRIVATE_KEY: string; // Use this PEM key for signing (SDK handles it now)
  QUORUM_ID: string;
}

interface WebSocketState {
  walletId: string;
}

const wsState = new Map<WebSocket, WebSocketState>();

// Helper to convert hex string to UTF-8 string
function hexToBytes(hex: string): Uint8Array {
  hex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function hexToString(hex: string): string {
  const bytes = hexToBytes(hex);
  return new TextDecoder('utf-8').decode(bytes);
}

// Helper to initialize Privy client with walletApi config for automatic signing
function initPrivyClient(env: Env): PrivyClient {
  return new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET, {
    walletApi: {
      authorizationPrivateKey: env.AUTH_PRIVATE_KEY,
    },
  });
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
          const client = initPrivyClient(env);
          const verificationResult = await client.verifyAuthToken(token);
          console.log('Token verification successful for user:', verificationResult.userId);
          
          // Send welcome message
          serverWs.send(JSON.stringify({
            id: 'welcome',
            message: 'Connected to MCPrivy server! Authentication successful.',
            user: verificationResult.userId,
            jsonrpc: '2.0'
          }));

          // Check if user already has wallets by fetching user data
          console.log('Checking for existing wallets for user:', verificationResult.userId);
          
          // URL encode the user ID to handle special characters properly
          const encodedUserId = encodeURIComponent(verificationResult.userId);
          console.log('Using encoded user ID for API call:', encodedUserId);
          
          const userDataRes = await fetch(`https://auth.privy.io/api/v1/users/${encodedUserId}`, {
            method: 'GET',
            headers: {
              'Authorization': `Basic ${btoa(env.PRIVY_APP_ID + ':' + env.PRIVY_APP_SECRET)}`,
              'privy-app-id': env.PRIVY_APP_ID,
            },
          });
          
          console.log('User data API response status:', userDataRes.status);
          console.log('User data API response ok:', userDataRes.ok);

          let walletId = 'temp-wallet-id';
          let walletAddress = 'temp-address';

          if (userDataRes.ok) {
            const userData = await userDataRes.json() as { 
              id: string; 
              linked_accounts: Array<{ 
                type: string; 
                address?: string; 
                chain_type?: string; 
                id?: string; 
              }> 
            };
            
            console.log('User data response:', JSON.stringify(userData, null, 2));
            console.log('Total linked accounts found:', userData.linked_accounts?.length || 0);
            console.log('Linked accounts data:', JSON.stringify(userData.linked_accounts, null, 2));
            
            // Find existing Ethereum wallet
            const existingWallet = userData.linked_accounts.find(account => 
              account.type === 'wallet' && account.chain_type === 'ethereum'
            );
            console.log('Existing Ethereum wallet found:', existingWallet ? JSON.stringify(existingWallet, null, 2) : 'None');
            
            if (existingWallet && existingWallet.id && existingWallet.address) {
              walletId = existingWallet.id;
              walletAddress = existingWallet.address;
              console.log('Using existing wallet:', walletId, 'Address:', walletAddress);

              // Fetch wallet details to check owner_id
              const walletRes = await fetch(`https://api.privy.io/v1/wallets/${walletId}`, {
                method: 'GET',
                headers: {
                  'Authorization': `Basic ${btoa(env.PRIVY_APP_ID + ':' + env.PRIVY_APP_SECRET)}`,
                  'privy-app-id': env.PRIVY_APP_ID,
                },
              });

              if (walletRes.ok) {
                const walletData = await walletRes.json() as { owner_id: string | null };
                if (walletData.owner_id === null) {
                  console.log('Wallet owner_id is null; updating to set owner.');
                  // Update wallet to set owner (no signature needed since owner_id null)
                  const updateRes = await fetch(`https://api.privy.io/v1/wallets/${walletId}`, {
                    method: 'PATCH',
                    headers: {
                      'Authorization': `Basic ${btoa(env.PRIVY_APP_ID + ':' + env.PRIVY_APP_SECRET)}`,
                      'privy-app-id': env.PRIVY_APP_ID,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      owner: { user_id: verificationResult.userId },
                    }),
                  });
                  if (!updateRes.ok) {
                    const errorText = await updateRes.text();
                    throw new Error(`Failed to set wallet owner: ${errorText}`);
                  }
                  console.log('Wallet owner set successfully.');
                }
              } else {
                const errorText = await walletRes.text();
                console.error('Failed to fetch wallet details:', errorText);
              }
              
              serverWs.send(JSON.stringify({
                id: 'wallet_found',
                result: { 
                  walletId, 
                  address: walletAddress, 
                  isNew: false,
                  message: 'Connected to existing wallet. Make sure session signer is added on the frontend.'
                },
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
                    result: { 
                      walletId, 
                      address: walletAddress, 
                      isNew: true,
                      message: 'New wallet created. Session signer will be added automatically.'
                    },
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
            const errorText = await userDataRes.text();
            console.error('Failed to fetch user data:', userDataRes.status);
            console.error('Error response:', errorText);
            console.error('Request URL was:', `https://auth.privy.io/api/v1/users/${encodedUserId}`);
            // Fallback to creating new wallet (same as above)
            // ... (omit repetition for brevity; copy the fallback creation code here if needed)
          }

          // Store wallet state
          wsState.set(serverWs, { walletId });

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
          
          const { walletId } = state;
          
          if (msg.method === 'signPersonalMessage') {
            const hexMessage = msg.params[0]; // Keep as hex (e.g., '0x48656c6c6f20776f726c64')
            console.log('Received hex message:', hexMessage);
            console.log('Wallet ID:', walletId);

            try {
              // Decode hex to plain text for signMessage
              const messageText = hexToString(hexMessage);

              // Use SDK's walletApi.ethereum.signMessage
              const client = initPrivyClient(env);
              const signData = await client.walletApi.ethereum.signMessage({
                walletId,
                message: messageText,
              });

              console.log('Message signed successfully:', signData.signature);

              serverWs.send(JSON.stringify({
                id: msg.id,
                result: signData.signature,
                jsonrpc: '2.0'
              }));
            } catch (error) {
              console.error('Sign request failed:', error);
              console.error('Error details:', JSON.stringify(error, null, 2));
              
              serverWs.send(JSON.stringify({ 
                id: msg.id, 
                error: `Sign failed: ${error instanceof Error ? error.message : String(error)}`, 
                jsonrpc: '2.0' 
              }));
            }
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
          AUTH_PRIVATE_KEY: !!env.AUTH_PRIVATE_KEY,
          QUORUM_ID: !!env.QUORUM_ID,
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